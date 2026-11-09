import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { createPluginRuntimeOccurrenceId } from '@/plugins/runtime/runtimeSlots';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import fastify from 'fastify';
import axios from 'axios';
import {
  API_TOKEN_FULL_GRANT_V1,
  EXTERNAL_ACTION_EFFECT_ACTION_HEADER,
  EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER,
  EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER,
  verifyExternalActionMachineRequestV1,
  projectSessionAccessCapabilitiesV1,
  FeaturesResponseSchema,
  ExternalActionExecutionAuthorizationV1Schema,
  type ExternalActionExecutionAuthorizationV1,
  type PluginInputTypeContributionV1,
} from '@happier-dev/protocol';
import tweetnacl from 'tweetnacl';
import { SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS } from '@happier-dev/protocol/rpc';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import type { RawSessionRecord } from '@/session/transport/http/sessionsHttp';
import { decodeBase64, decrypt } from '@/api/encryption';
import { createSessionBoardActionDeps } from './sessionBoardActionDeps';
import { validateSessionSystemRecordOpenedContent } from '@/session/systemRecords/sessionSystemRecordCodec';
import { createActionExecutor, type ActionExecutorDeps } from '@happier-dev/protocol/actions';
import { createWidgetActionInputResolverV1 } from '@happier-dev/protocol/widgets/widgetActionInputResolverV1';
import {
  CURRENT_SESSION_PRESENTATION_ACK_RPC_METHOD,
  CURRENT_SESSION_PRESENTATION_AGENT_STATE_KEY,
  CURRENT_SESSION_PRESENTATION_BIND_RPC_METHOD,
  CurrentSessionPresentationStateV1Schema,
} from '@happier-dev/protocol/sessions';
import type { AgentState } from '@/api/types';
import type { RpcHandler } from '@/api/rpc/types';
import type { SessionClientPort } from '@/api/session/sessionClientPort';
import type { CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { createActionToolExecutorBridge } from '@/agent/tools/happierTools/createActionToolExecutorBridge';
import { createCurrentSessionPresentationService } from '@/session/presentation/currentSessionPresentationService';
import { listBuiltInHappierTools } from '@/agent/tools/happierTools/listBuiltInHappierTools';
import { resolveTranscriptSessionBoardItemReferenceV1 } from '@happier-dev/protocol/sessions/board/transcriptReference';
import { buildHappierToolsPromptAppendix } from '@/agent/tools/happierTools/runtime/buildHappierToolsPromptAppendix';
import { parseTrustedHappierToolsShellBridgeCommand } from '@/agent/tools/happierTools/runtime/buildHappierToolsShellBridgeCommand';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod/mini';
import type { ApprovalRequest } from '@happier-dev/protocol';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { registerHappierMcpBuiltInTools } from '@/mcp/server/registerHappierMcpBuiltInTools';
import { createHappierMcpServer } from '@/mcp/createHappierMcpServer';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { createCliWidgetDefinitionActionDepsV1 } from '@/session/actions/widgetDefinitionActionDeps';
import { SessionBoardMutationV1Schema } from '@happier-dev/protocol/sessions/board/mutations';
import type { WidgetDefinitionArtifactV1 } from '@happier-dev/protocol/widgets';
import { createSessionBoardWidgetActionPortV1 } from '@happier-dev/protocol/widgets';
import { createCliActionDeps } from '@/session/actions/createCliActionDeps';
import { PluginProjectionV2Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createCliActionExecutorHarness } from '@/session/actions/createCliActionExecutorHarness';
import { createRegistryInputTypeDeps } from '@/plugins/runtime/invocation/actions/createCommittedContributedActionDeps';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { normalizePluginUiInlineSurfaceBindingV1 } from '@happier-dev/protocol/plugins/ui';
import { configuration } from '@/configuration';
import { writeSettings, SUPPORTED_SCHEMA_VERSION } from '@/persistence';
import { findCompiledActionCliCommand } from '@/cli/actions/compiledCommands';
import { composeActionCliInput, parseActionCliCommandInput } from '@/cli/actions/parseCommandInput';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import { artifactListResponse } from '@/testkit/http/artifactHome';
import { AccountEncryptionModeResponseSchema } from '@happier-dev/protocol/account/encryptionMode';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { createScopedRuntimeActionSettingsProvider } from '@/settings/scopedRuntimeActionSettingsProvider';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { createCredentialedAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { createCliApprovalsArtifactStore } from '@/session/actions/approvals/artifactStore';
import { registerPlainArtifactRoutes } from '@/session/actions/widgetApproval.testkit';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { resetInMemoryAccountSettingsContextForTests } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { resetServerFeaturesClientForTests } from '@/features/serverFeaturesClient';

const revision = 'ssr1.AAAACHN5c3JlY18xAAAAAQ';
const allowedVisualPolicy = { actionsSettingsV1: { v: 1,
  approvalWaivedSurfaces: { 'session.board.item.upsert': ['agent'] },
} };
const item = { v: 1, destination: 'board', title: 'Note', frame: 'card', height: { mode: 'auto', fallback: 'regular' },
  source: { kind: 'declarative', document: { version: 1, root: { kind: 'markdown', text: 'Hello' } } },
} as const;
const installed = { ...item, source: { kind: 'widget', instance: {
  v: 1, id: 'status', definition: { kind: 'installed', surface: { pluginId: 'acme.widgets', localId: 'status' } }, bindings: {},
} } } as const;
const rawSession: RawSessionRecord = {
  id: 'session-one', seq: 1, createdAt: 1, updatedAt: 1, active: false, activeAt: 1,
  encryptionMode: 'plain', metadata: '{}', metadataVersion: 1, dataEncryptionKey: null, agentState: null, agentStateVersion: 0,
  effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }], capabilities: projectSessionAccessCapabilitiesV1({ owner: true, grants: [] }) },
  responsibleAccountId: null,
  responsibleAccount: null,
};

describe('CLI Board Action family', () => {
  let app = fastify();
  let restore = () => {};
  let verifySessionRequest: ((request: Readonly<{ headers?: unknown; query?: unknown }>) => void) | undefined;
  let verifyAccountRequest: ((request: Readonly<{ headers: Record<string, unknown>; url: string; method: string }>) => void) | undefined;
  let accountSettingsBody: Readonly<Record<string, unknown>> = {};
  beforeEach(() => {
    app = fastify();
    rawSession.encryptionMode = 'plain';
    rawSession.effectiveAccess = {
      v: 1,
      level: 'owner',
      sources: [{ kind: 'owner' }],
      capabilities: projectSessionAccessCapabilitiesV1({ owner: true, grants: [] }),
    };
    restore = installAxiosFastifyAdapter({ app, origin: 'http://board.test' });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({
      features: {
        sessions: { enabled: true, board: { enabled: true } },
        sharing: { session: { enabled: true } },
      },
      capabilities: {},
    })));
    verifySessionRequest = undefined;
    verifyAccountRequest = undefined;
    accountSettingsBody = {};
    app.get('/v1/account/encryption/currentness', async request => {
      verifyAccountRequest?.(request);
      return createAccountEncryptionCurrentnessFixture();
    });
    app.get('/v1/account/encryption', async request => {
      verifyAccountRequest?.(request);
      return AccountEncryptionModeResponseSchema.parse({ mode: 'plain', updatedAt: 1 });
    });
    app.get('/v2/account/settings', async () => ({ content: { t: 'plain', v: accountSettingsBody }, version: 1 }));
    app.get('/v2/sessions/session-one', async (request) => {
      verifySessionRequest?.(request);
      return { session: rawSession };
    });
  });
  afterEach(async () => { restore(); vi.restoreAllMocks(); await app.close(); });
  it('refuses invalid library copy identities before approval and executes an approved UUID copy through the Artifact HTTP contract', async () => {
    const resetContext = () => { resetInMemoryAccountSettingsContextForTests(); resetServerFeaturesClientForTests(); };
    resetContext();
    onTestFinished(resetContext);
    const account = { serverId: 'srv_savecopy_test', accountId: 'account' };
    const credentials = { token: `fixture.${Buffer.from(JSON.stringify({ sub: account.accountId,
      provenance: { v: 1, kind: 'account', authority: 'present_user' },
    })).toString('base64url')}.signature`, encryption: null, credentialProvenance: 'stored_session' as const };
    // The shared HTTP boundary uses the server's canonical create grammar.
    registerPlainArtifactRoutes(app, account.accountId);
    let creates = 0;
    app.addHook('onRequest', async request => { if (request.method === 'POST' && request.url === '/v1/artifacts') creates++; });
    app.get('/v1/account/profile', async () => ({ id: account.accountId }));
    vi.mocked(globalThis.fetch).mockImplementation(async () => Response.json(FeaturesResponseSchema.parse({
      features: { sessions: { enabled: true, board: { enabled: true } } },
      capabilities: { serverIdentity: { serverIdentityId: account.serverId } },
    })));
    app.get('/v2/sessions/session-one/system-records/record', async request => ({
      record: (request.query as Record<string, string>).kind === 'layout.v1' ? null : {
        id: 'source-row', address: { owner: 'host', namespace: 'surface', kind: 'item.v1', localId: 'source' },
        revision, content: { t: 'plain', v: item }, createdAt: '2026-10-30T00:00:00.000Z', updatedAt: '2026-10-30T00:00:00.000Z',
      },
    }));
    await runWithServerHttpBaseUrl('http://board.test', async () => {
      const artifacts = createCredentialedAccountArtifactStore(credentials);
      const approvals = createCliApprovalsArtifactStore({ credentials, serverId: account.serverId,
        serverHttpBaseUrl: 'http://board.test' });
      const deps: ActionExecutorDeps = { ...createUnavailableActionTransportDeps(), ...approvals,
        ...createSessionBoardActionDeps({ credentials, serverId: account.serverId, serverHttpBaseUrl: 'http://board.test' }),
        widgetAccountScope: () => account,
      };
      Object.assign(deps, createCliWidgetDefinitionActionDepsV1({ accountId: account.accountId,
        transport: artifacts, getDeps: () => deps, readCandidates: async () => [] }));
      const executor = createActionExecutor(deps);
      const context = { surface: 'agent', authority: 'account_automation', serverId: account.serverId, serverIdentityId: account.serverId,
        runtimeAccountId: account.accountId, defaultSessionId: 'session-one', defaultSessionMachineId: 'machine',
        actionCaller: { kind: 'session', sessionId: 'session-one', starterDepth: 0, turnDepth: 0 },
        actionRequestId: randomUUID() } as const;
      const input = { account, session: { serverId: account.serverId, sessionId: 'session-one' }, itemId: 'source',
        artifactId: 'qa-vis-legs-1030-chart-definition' };
      expect(await executor.execute('widgets.definition.saveFromSession', input, context))
        .toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
      expect(creates).toBe(0);
      const artifactId = randomUUID();
      const created = await executor.execute('widgets.definition.saveFromSession', { ...input, artifactId }, context);
      expect(created).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
      if (!created.ok) throw new Error('Expected a Save approval');
      const approval = ActionApprovalRequestCreatedResultSchema.parse(created.result);
      expect(await artifacts.read(artifactId)).toBeNull();
      const decidingExecutor = createCliActionExecutorFromCredentials({ credentials, serverId: account.serverId,
        serverIdentityId: account.serverId, serverApiUrl: 'http://board.test', readCredentials: async () => credentials });
      const decided = await decidingExecutor.execute('approval.request.decide', { artifactId: approval.artifactId, decision: 'approve' }, {
        surface: 'cli', authority: 'present_user', serverId: account.serverId, runtimeAccountId: account.accountId,
        actionCaller: { kind: 'host' },
      });
      expect(decided, JSON.stringify(decided))
        .toMatchObject({ ok: true, result: { status: 'executed', execution: { ok: true } } });
      expect(await deps.widgetDefinitionArtifacts!.get(artifactId)).toMatchObject({ id: artifactId,
        body: { kind: 'declarative', document: item.source.document }, provenance: { source: { kind: 'session', itemId: 'source' } } });
      expect(await approvals.approvalsGet({ artifactId: approval.artifactId }))
        .toMatchObject({ status: 'executed', execution: { ok: true } });
    });
  });
  it('reads the strict scalar projection without crypto, item bodies or layout', async () => {
    rawSession.encryptionMode = 'e2ee';
    let reads = 0;
    app.get('/v2/sessions/session-one/system-records', async request => {
      reads++;
      expect(request.query).toEqual({ owner: 'host', namespace: 'surface', kind: 'item.v1', projection: 'count' });
      return { count: 1200 };
    });
    const deps = createSessionBoardActionDeps({ credentials: { token: 'daemon-token', encryption: null },
      serverId: 'home-a', serverHttpBaseUrl: 'http://board.test' });
    await expect(deps.sessionBoardAction!({ actionId: 'session.board.get', context: {
      surface: 'cli', authority: 'present_user', serverId: 'home-a',
    }, input: { sessionId: 'session-one', projection: 'count' } }))
      .resolves.toEqual({ v: 1, serverId: 'home-a', sessionId: 'session-one', count: 1200 });
    expect(reads).toBe(1);
  });
  it.each(['counter', 'snapshot-counter'].flatMap(localId => [false, true].map(native => ({ localId, native }))))('admits the recorded installed $localId Board inputs (native Account: $native) through real type and options owners', async ({ localId, native }) => {
    const serverIdentityId = 'srv_niq7wbpMyJviL4EtO5YlTEd0Us0Ou0nN';
    const accountId = '5e3a0581-6f3d-4e73-bf40-383db0be6c3e';
    const sessionId = 'cmvcclhrd007jmcc96w9yb0vx';
    const pluginId = 'examples.widget-areas';
    const token = `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
    const inputType = { pluginId, localId: 'count-kind' };
    const type: PluginInputTypeContributionV1 = { id: inputType.localId, title: 'Count kind', semantic: 'directory-count-kind',
      valueSchema: { type: 'string', enum: ['files', 'folders'] }, options: { resource: 'count-kinds' } };
    const binding = normalizePluginUiInlineSurfaceBindingV1({ pluginId, surfaceId: localId,
      rendererId: 'counter', role: 'widget', target: { kind: 'app' } });
    if (!binding) throw new Error('Expected the canonical widget binding');
    const occurrenceId = createPluginRuntimeOccurrenceId(pluginId);
    const projection = PluginProjectionV2Schema.parse({ v: 2, generation: 1, familiesById: {
      pluginUi: { family: 'pluginUi', entriesById: { counter: { id: 'counter', pluginId, contributionKind: 'surfacePlacement',
        descriptorId: localId, occurrenceId, binding, target: binding.target, display: { title: 'Directory count' },
        sizeDeclaration: { sizes: ['small', 'medium', 'wide', 'full'], defaultSize: 'medium' },
        inputs: { fields: [{ path: 'directory', title: 'Directory on the serving machine', widget: 'text', required: true },
          { path: 'filter', title: 'Count', widget: 'select', required: true, inputType }] },
        inputSchema: { type: 'object', additionalProperties: false, required: ['directory', 'filter'],
          properties: { directory: { type: 'string', minLength: 1 }, filter: type.valueSchema } },
      } } },
      inputTypes: { family: 'inputTypes', entriesById: { [`${pluginId}/count-kind`]: {
        id: `${pluginId}/count-kind`, pluginId, pluginVersion: '1.0.0', occurrenceId, definition: type,
      } } },
    } });
    const registry = createResolvedContributionRegistry({ occurrenceIdsByPluginId: { [pluginId]: occurrenceId },
      inputTypes: [{ provenance: 'external', source: { kind: 'path' }, pluginId, identity: inputType,
        manifestPath: '/plugins/widgets/plugin.json', definition: type }],
      resources: [{ provenance: 'external', source: { kind: 'path' }, pluginId,
        definition: { kindVersion: 1, id: 'count-kinds', source: 'dynamic', type: 'config', scope: 'global', contentType: 'application/json' } }],
    });
    let revoked: 'owner' | 'selected' | null = null;
    const selectedSessionId = 'c000000000000000000000063';
    const signedRequests: string[] = [];
    app.addHook('preHandler', async (request, reply) => {
      if (request.headers[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]) {
        signedRequests.push(request.url);
        // Home admits an authenticated original root only for its own effect.
        // A composite options read cannot borrow session.board.get authority.
        if (request.headers[EXTERNAL_ACTION_EFFECT_ACTION_HEADER] !== 'action.options.resolve') {
          return reply.code(401).send({ error: 'not_authenticated' });
        }
      }
    });
    app.get(`/v2/sessions/${sessionId}`, async () => ({ session: { ...rawSession, id: sessionId,
      metadata: JSON.stringify({ machineId: 'machine-one' }),
      ...(revoked === 'owner' ? { effectiveAccess: { ...rawSession.effectiveAccess!,
        capabilities: { ...rawSession.effectiveAccess!.capabilities, readTranscript: false } } } : {}),
    } }));
    app.get(`/v2/sessions/${selectedSessionId}`, async (_request, reply) => revoked === 'selected'
      ? reply.code(403).send({ error: 'forbidden' })
      : { session: { ...rawSession, id: selectedSessionId, metadata: JSON.stringify({ machineId: 'machine-one' }) } });
    app.get('/v1/artifacts', async () => []);
    app.get(`/v2/sessions/${sessionId}/system-records/record`, async () => ({ record: null }));
    app.get(`/v2/sessions/${sessionId}/system-records`, async () => ({ records: [], hasNext: false, nextCursor: null }));
    const signingKey = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(31));
    let resourceReads = 0;
    const { executor, deps } = createCliActionExecutorHarness({ credentials: { token, encryption: null }, token,
      sessionId: 'cli-global', mode: 'plain', ctx: null, serverId: 'local-profile', serverIdentityId, serverHttpBaseUrl: 'http://board.test',
      externalActionMachineInstallationId: 'widget-installation', externalActionMachineRequestPrivateKey: signingKey.secretKey,
      machineActionDirectTargetTransport: { machineId: 'machine-one', invoke: async () => ({ protocolVersion: 1, projection }) },
    }, createRegistryInputTypeDeps({ contributes: registry, readUiResource: async () => { resourceReads++; return ({
      resource: { pluginId, localId: 'count-kinds' }, kind: 'config', contentType: 'application/json',
      digest: `sha256:${'a'.repeat(64)}`, bytes: new TextEncoder().encode(JSON.stringify([
        { value: 'files', label: 'Files' }, { value: 'folders', label: 'Folders' },
      ])),
    }); } }));
    const surface = { serverId: serverIdentityId, accountId, owner: { kind: 'sessionBoard' as const, sessionId } };
    const instance = { v: 1 as const, id: 'c15c9e20-f054-4681-ae82-cb89c6cf5533',
      definition: { kind: 'installed' as const, surface: { pluginId, localId } }, bindings: {
        directory: { kind: 'value' as const, value: '/home/happier/happier-dev/packages/plugin-sdk/examples/widget-areas' },
        filter: { kind: 'value' as const, value: 'files' },
      } };
    const context = { surface: 'cli' as const, serverId: 'local-profile', authority: 'present_user' as const };
    const resolved = await runWithServerHttpBaseUrl('http://board.test', () => deps.widgetInputs!.resolve({
      ref: { surface, instanceId: instance.id }, instance, admission: 'configuration', context,
    }));
    expect(resolved).toEqual({ status: 'ready', input: { directory: instance.bindings.directory.value, filter: 'files' } });
    const optionsContext = native ? { ...context, surface: 'ui' as const, actionCaller: { kind: 'host' as const },
      externalActionTarget: { kind: 'machine' as const, machineId: 'machine-one' },
      externalActionExecutionAuthorization: ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'native-options-proof', binding: {
        accountId, authentication: { kind: 'account', tokenEpoch: 1 }, accountEncryptionMode: 'plain',
        serverIdentityId, machineId: 'machine-one', custodianAccountId: accountId, installationId: 'widget-installation',
        actionId: 'action.options.resolve', requestId: 'native-options', requestEnvelopeDigest: 'a'.repeat(43),
        target: { kind: 'machine', machineId: 'machine-one' },
      } }),
    } : context;
    const optionsInput = {
      consumer: { kind: 'widget', surface, definition: instance.definition }, fieldPath: 'filter',
      draftInput: { directory: instance.bindings.directory.value },
    };
    const options = await runWithServerHttpBaseUrl('http://board.test', () => executor.execute('action.options.resolve', optionsInput, optionsContext));
    expect(options, JSON.stringify({ options, signedRequests })).toMatchObject({ ok: true, result: { options: [{ value: 'files' }, { value: 'folders' }] } });
    expect(signedRequests).toEqual([]);
    for (const owner of ['sessionBoard', 'companion'] as const) {
      const selectedInput = { ...optionsInput, consumer: { ...optionsInput.consumer,
        surface: { ...surface, owner: { kind: owner, sessionId } }, selectedSession: { serverId: serverIdentityId, sessionId: selectedSessionId } } };
      expect(await runWithServerHttpBaseUrl('http://board.test', () => executor.execute('action.options.resolve', selectedInput, optionsContext)))
        .toMatchObject({ ok: true, result: { options: [{ value: 'files' }, { value: 'folders' }] } });
      for (const deniedSession of ['owner', 'selected'] as const) {
        revoked = deniedSession;
        const beforeRead = resourceReads;
        const denied = await runWithServerHttpBaseUrl('http://board.test', () => executor.execute('action.options.resolve', selectedInput, optionsContext));
        expect(denied).toMatchObject({ ok: false });
        expect(denied).not.toHaveProperty('result.options');
        expect(resourceReads).toBe(beforeRead);
      }
      revoked = null;
    }
  });
  it('discovers widgets on a Session Board addressed by its portable Home', async () => {
    const serverIdentityId = 'srv_board_identity';
    const sessionId = 'c000000000000000000000052';
    app.get(`/v2/sessions/${sessionId}`, async () => ({ session: { ...rawSession, id: sessionId } }));
    app.get(`/v2/sessions/${sessionId}/system-records/record`, async () => ({ record: null }));
    app.get(`/v2/sessions/${sessionId}/system-records`, async () => ({ records: [], hasNext: false, nextCursor: null }));
    const deps = createCliActionDeps({ credentials: { token: 'token', encryption: null }, token: 'token',
      sessionId, mode: 'plain', ctx: null,
      serverId: 'local-profile', serverIdentityId, serverHttpBaseUrl: 'http://board.test',
      machineActionDirectTargetTransport: { machineId: 'machine-one', invoke: async () => ({ protocolVersion: 1,
        projection: PluginProjectionV2Schema.parse({ v: 2, generation: 1 }) }) } });
    const surface = { serverId: serverIdentityId, accountId: 'owner', owner: { kind: 'sessionBoard' as const, sessionId } };
    const result = await runWithServerHttpBaseUrl('http://board.test', () => deps.widgetCatalog!.list(surface, { serverId: 'local-profile' }));
    expect(result).toEqual(expect.arrayContaining([expect.objectContaining({ definition: { kind: 'builtin', id: 'session_summary' } })]));
  });
  it.each(['widgets.catalog.list', 'widgets.item.list'] as const)(
    'retains the admitted agent %s root through composed Board reads', async actionId => {
      const serverIdentityId = 'srv_board_identity';
      const accountId = 'owner';
      const sessionId = 'c000000000000000000000052';
      const token = `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
      const signingKey = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(32));
      const target = { kind: 'machine' as const, machineId: 'machine-one' };
      const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'agent-read-proof', binding: {
        accountId, authentication: { kind: 'account', tokenEpoch: 1 }, accountEncryptionMode: 'plain',
        serverIdentityId, machineId: target.machineId, custodianAccountId: accountId, installationId: 'installation-one',
        actionId, requestId: 'agent-read', requestEnvelopeDigest: 'a'.repeat(43), target,
      } });
      const signedPaths: string[] = [];
      app.addHook('preHandler', async (request, reply) => {
        if (!request.headers[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]) return;
        signedPaths.push(request.url);
        const valid = request.headers[EXTERNAL_ACTION_EFFECT_ACTION_HEADER] === actionId
          && verifyExternalActionMachineRequestV1({ authorizationToken: authorization.token, effectActionId: actionId,
            target, installationId: 'installation-one', requestId: 'agent-read', method: request.method,
            path: request.url, publicKey: signingKey.publicKey,
            signature: String(request.headers[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]) });
        if (!valid) return reply.code(401).send({ error: 'not_authenticated' });
      });
      app.get('/v1/artifacts', async request => artifactListResponse(request.url, []));
      app.get(`/v2/sessions/${sessionId}`, async () => ({ session: { ...rawSession, id: sessionId } }));
      app.get('/v2/sessions', async () => ({ sessions: [{ ...rawSession, id: sessionId }], hasNext: false, nextCursor: null }));
      app.get('/v2/sessions/archived', async () => ({ sessions: [], hasNext: false, nextCursor: null }));
      app.get(`/v2/sessions/${sessionId}/system-records/record`, async () => ({ record: null }));
      app.get(`/v2/sessions/${sessionId}/system-records`, async () => ({ records: [], hasNext: false, nextCursor: null }));
      const { executor } = createCliActionExecutorHarness({ credentials: { token, encryption: null }, token,
        sessionId: 'cli-global', mode: 'plain', ctx: null, serverId: 'local-profile', serverIdentityId,
        serverHttpBaseUrl: 'http://board.test', externalActionMachineInstallationId: 'installation-one',
        externalActionMachineRequestPrivateKey: signingKey.secretKey,
        machineActionDirectTargetTransport: { machineId: target.machineId, invoke: async () => ({ protocolVersion: 1,
          projection: PluginProjectionV2Schema.parse({ v: 2, generation: 1 }) }) },
      });
      const bridge = createActionToolExecutorBridge({ surface: 'agent', executor: {
        execute: (id, input, context) => executor.execute(id, input, { ...context,
          externalActionExecutionAuthorization: authorization, externalActionTarget: target }),
      } });
      const surface = { serverId: serverIdentityId, accountId, owner: { kind: 'sessionBoard' as const, sessionId } };
      const result = await bridge.executeActionByToolName('action_execute', {
        actionId, input: { surface },
      }, sessionId);
      expect(result, JSON.stringify({ result, signedPaths })).toMatchObject({ ok: true });
      expect(signedPaths).toContain(`/v2/sessions/${sessionId}?accessProjectionVersion=1`);
      expect(signedPaths.some(path => path.startsWith(`/v2/sessions/${sessionId}/system-records`))).toBe(true);
    });
  it('admits the portable Home through the widget Board port while retaining exact HTTP routing', async () => {
    const serverIdentityId = 'srv_board_identity';
    const writes: unknown[] = [];
    app.get('/v2/sessions/session-one/system-records/record', async () => ({ record: null }));
    app.get('/v2/sessions/session-one/system-records', async () => ({ records: [], hasNext: false, nextCursor: null }));
    app.put('/v2/sessions/session-one/board', async request => {
      writes.push(request.body);
      return { operation: 'upsert_item', itemId: 'capacity', outcome: 'created', itemRevision: revision, layoutRevision: revision };
    });
    const deps = createSessionBoardActionDeps({ credentials: { token: 'token', encryption: null },
      serverId: 'local-profile', serverIdentityId, serverHttpBaseUrl: 'http://board.test' });
    const port = createSessionBoardWidgetActionPortV1(deps.sessionBoardAction!);
    const surface = { serverId: serverIdentityId, accountId: 'owner', owner: { kind: 'sessionBoard' as const, sessionId: 'session-one' } };
    const instance = { v: 1 as const, id: 'capacity', definition: { kind: 'builtin' as const, id: 'usage_capacity' }, bindings: {} };
    expect(await port.read(surface, { serverId: 'local-profile' })).toMatchObject({ surface, canEdit: true, instances: [] });
    expect(await deps.sessionBoardPrepareItem!({ input: { sessionId: 'session-one', itemId: 'capacity', expectedItemRevision: null, item },
      context: { serverId: serverIdentityId } })).toMatchObject({ item });
    expect(await port.apply(surface, { kind: 'add', instance, presentation: { size: 'medium' },
      placement: { tabId: 'overview', tabTitle: 'Overview', width: 'wide' } }, { serverId: 'local-profile' }))
      .toMatchObject({ ok: true, result: { ref: { surface, instanceId: 'capacity' }, instance } });
    expect(writes).toEqual([expect.objectContaining({ itemId: 'capacity', itemContent: { t: 'plain', v: expect.objectContaining({ source: { kind: 'widget', instance } }) } })]);
    expect(await port.read({ ...surface, serverId: 'srv_foreign' }, {})).toMatchObject({ ok: false, errorCode: 'server_target_mismatch' });
    expect(await deps.sessionBoardPrepareItem!({ input: { sessionId: 'session-one', itemId: 'capacity', expectedItemRevision: null, item },
      context: { serverId: 'srv_foreign' } })).toMatchObject({ ok: false, errorCode: 'server_target_mismatch' });
    expect(writes).toHaveLength(1);
  });
  it.each([200, 500] as const)('preserves the HTTP %s visual outcome through the real Account-backed Session MCP factory', async status => {
    accountSettingsBody = allowedVisualPolicy;
    app.get('/v2/sessions/runtime-session', async () => ({ session: { ...rawSession, id: 'runtime-session' } }));
    app.get('/v2/sessions/runtime-session/system-records/record', async () => ({ record: null }));
    const writes: unknown[] = [];
    app.put('/v2/sessions/runtime-session/board', async (request, reply) => {
      if (status === 500) return reply.code(status).send({ error: 'Internal Server Error',
        message: 'could not serialize access due to concurrent update' });
      writes.push(request.body);
      return { operation: 'upsert_item', itemId: 'visual', outcome: 'created', itemRevision: revision };
    });
    const runtime = createHappierMcpServer({
      sessionId: 'runtime-session',
      getServerBinding: () => ({ serverId: 'home-a', serverUrl: 'http://board.test' }),
      getServerFeaturesSnapshot: () => ({ status: 'ready', provenance: 'authenticated', features: FeaturesResponseSchema.parse({
        features: { sessions: { enabled: true, board: { enabled: true } }, sharing: { session: { enabled: true } } },
        capabilities: { serverIdentity: { serverIdentityId: 'srv_board_runtime' } },
      }) }),
      rpcHandlerManager: new RpcHandlerManager({ scopePrefix: 'runtime-session', encryptionMode: 'plain' }),
      updateMetadata() {}, getMetadataSnapshot: () => createTestMetadata(),
      getWorkDepth: () => 0, getHostTurnWorkDepth: () => 0,
      getActiveTurnPermissionWitness: () => ({ turnId: 'turn', causalPermissionAuthority: {
        kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'default',
      } }),
      getStoredContentEncryptionContext: () => ({ mode: 'plain' }),
    }, { authorityScope: 'account', accountSettings: accountSettingsParse(accountSettingsBody), credentials: { token: `fixture.${Buffer.from(JSON.stringify({
      sub: 'account', provenance: { v: 1, kind: 'account', authority: 'present_user' },
    })).toString('base64url')}.signature`, encryption: null } });
    const client = new Client({ name: 'runtime-agent', version: '1' });
    const [agentTransport, hostTransport] = InMemoryTransport.createLinkedPair();
    try {
      await runtime.mcp.connect(hostTransport);
      await client.connect(agentTransport);
      await client.listTools();
      const result = await client.callTool({ name: 'session_board_item_upsert', arguments: {
        itemId: 'visual', expectedItemRevision: null, destination: 'transcript', item: { ...item, destination: 'transcript' },
      } }, CallToolResultSchema);
      if (status === 500) {
        expect(result.isError).toBe(true);
        expect(result.content).toEqual([{ type: 'text', text: JSON.stringify({ errorCode: 'server_error', error: 'server_error' }) }]);
        expect(writes).toEqual([]);
        return;
      }
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ serverId: 'srv_board_runtime', sessionId: 'runtime-session', result: { itemId: 'visual', outcome: 'created' } });
      expect(writes).toEqual([expect.objectContaining({ itemId: 'visual', destination: 'transcript' })]);
    } finally { await client.close(); await runtime.mcp.close(); }
  });
  it('returns a truthful pending MCP result, then replays the approved visual into the same Session record', async () => {
    let committed: Record<string, unknown> | null = null;
    let approval: ApprovalRequest | null = null;
    app.get('/v2/sessions/session-one/system-records/record', async request => ({
      record: committed && (request.query as { kind?: string }).kind === 'item.v1' ? {
        id: 'visual-row', address: { owner: 'host', namespace: 'surface', kind: 'item.v1', localId: 'visual' },
        content: committed.itemContent, revision,
        createdAt: '2026-10-12T00:00:00.000Z', updatedAt: '2026-10-12T00:00:00.000Z',
      } : null,
    }));
    app.put('/v2/sessions/session-one/board', async request => {
      committed = request.body as Record<string, unknown>;
      return { operation: 'upsert_item', itemId: 'visual', outcome: 'created', itemRevision: revision };
    });
    const actionsSettings = normalizeActionsSettingsV1({ v: 1, actions: {
      'session.board.item.upsert': { approvalRequiredSurfaces: ['agent'] },
    } });
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(),
      ...createSessionBoardActionDeps({ credentials: { token: 'token', encryption: null },
        serverId: 'home-a', serverHttpBaseUrl: 'http://board.test' }),
      // Artifact persistence and authenticated origin currentness are boundaries.
      approvalsCreate: async ({ request }) => { approval = request; return { artifactId: 'approval' }; },
      approvalsGet: async () => approval,
      approvalsUpdate: async ({ request }) => { approval = request; return { ok: true }; },
      isApprovalExecutionOriginCurrent: async () => true,
    });
    const tools = createActionToolExecutorBridge({ surface: 'agent', executor: {
      execute: (id, value, context) => executor.execute(id, value, { ...context, serverId: 'home-a',
        runtimeAccountId: 'account', actionsSettings, defaultSessionMachineId: 'machine-one',
        actionCaller: { kind: 'session', sessionId: 'session-one', starterDepth: 0, turnDepth: 0 } }),
    } });
    const server = new McpServer({ name: 'visual-regression', version: '1' });
    const client = new Client({ name: 'visual-agent', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    registerHappierMcpBuiltInTools({ registerTool: (name, meta, handler) => {
      // Preserve the SDK's real input/output validation at the transport boundary.
      server.registerTool(name, meta as { inputSchema: z.ZodMiniType }, async (args, extra) => CallToolResultSchema.parse(await handler(args, extra)));
    } }, { sessionId: 'session-one', surface: 'agent', actionsSettings,
      deps: { changeTitle: async () => ({ success: true }), executeActionByToolName: tools.executeActionByToolName } });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const refused = CallToolResultSchema.parse(await client.callTool({ name: 'session_board_item_upsert', arguments: {
        itemId: 'invalid-html', expectedItemRevision: null, destination: 'transcript',
        item: { ...item, destination: 'transcript', source: { kind: 'hostedHtml', requestedCapabilities: {}, source: {
          v: 1, entrypoint: 'index.html', files: { 'index.html': { mime: 'text/html',
            contentBase64: Buffer.from('<script src="missing.js"></script>').toString('base64') } },
        } } },
      } }));
      expect(refused.isError).toBe(true);
      const refusalContent = refused.content[0];
      if (refusalContent?.type !== 'text') throw new Error('Expected typed Action refusal');
      expect(JSON.parse(refusalContent.text)).toMatchObject({ errorCode: 'invalid_parameters',
        details: { reason: 'source_invalid', field: 'item.source' } });
      expect(approval).toBeNull();
      expect(committed).toBeNull();
      const input = { itemId: 'visual', expectedItemRevision: null, destination: 'transcript',
        item: { ...item, destination: 'transcript' } };
      const pending = await client.callTool({ name: 'session_board_item_upsert', arguments: input });
      expect(pending).toMatchObject({ isError: false, structuredContent: {
        kind: 'approval_request_created', artifactId: 'approval', actionId: 'session.board.item.upsert',
      } });
      expect(committed).toBeNull();
      expect(resolveTranscriptSessionBoardItemReferenceV1({ toolName: 'session_board_item_upsert',
        state: 'completed', input, result: pending, address: { serverId: 'home-a', sessionId: 'session-one' } })).toBeNull();
      const decision = await executor.execute('approval.request.decide', { artifactId: 'approval', decision: 'approve' },
        { surface: 'ui', authority: 'present_user', serverId: 'home-a' });
      expect(decision).toMatchObject({ ok: true });
      expect(approval).toMatchObject({ status: 'executed', execution: { ok: true, result: {
        sessionId: 'session-one', result: { itemId: 'visual', outcome: 'created', itemRevision: revision },
      } } });
      expect(committed).toMatchObject({ itemId: 'visual', itemContent: { t: 'plain', v: {
        destination: 'transcript', source: item.source,
      } } });
      const readback = await client.callTool({ name: 'session_board_get', arguments: { itemIds: ['visual'] } });
      expect(readback).toMatchObject({ isError: false, structuredContent: { sessionId: 'session-one',
        items: [{ itemId: 'visual', revision, item: { destination: 'transcript', source: item.source } }] } });
    } finally { await client.close(); await server.close(); }
  });
  it('executes the projected visual example as an agent and emits a placement-free transcript reference', async () => {
    const tool = listBuiltInHappierTools({ surface: 'agent', actionsSettings: null, isActionEnabled: () => true })
      .find(candidate => candidate.actionId === 'session.board.item.upsert');
    const example = tool?.examples as { mcp?: { argsExample?: string } } | undefined;
    expect(example?.mcp?.argsExample).toBeTypeOf('string');
    const input = { ...JSON.parse(example!.mcp!.argsExample!), sessionId: 'session-one' };
    expect((tool!.inputSchema as z.ZodMiniType).safeParse(input).success).toBe(true);
    app.get('/v2/sessions/session-one/system-records/record', async () => ({ record: null }));
    let committed: unknown;
    app.put('/v2/sessions/session-one/board', async request => {
      committed = request.body;
      return { operation: 'upsert_item', itemId: input.itemId, outcome: 'created', itemRevision: revision };
    });
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(),
      ...createSessionBoardActionDeps({ credentials: { token: 'token', encryption: null },
        serverId: 'home-a', serverHttpBaseUrl: 'http://board.test' }) });
    const tools = createActionToolExecutorBridge({ surface: 'agent', executor: {
      execute: (id, value, context) => executor.execute(id, value, { ...context, serverId: 'home-a',
        actionsSettings: normalizeActionsSettingsV1(allowedVisualPolicy.actionsSettingsV1),
        actionCaller: { kind: 'session', sessionId: 'session-one', starterDepth: 0, turnDepth: 0 } }),
    } });
    const result = await tools.executeActionByToolName(tool!.name, input, 'session-one');
    expect(result).toMatchObject({ ok: true });
    expect(committed).toMatchObject({ itemContent: { t: 'plain', v: {
      destination: 'transcript', source: input.item.source,
    } } });
    expect(committed).not.toHaveProperty('placement');
    expect(resolveTranscriptSessionBoardItemReferenceV1({ toolName: tool!.name, state: 'completed', input,
      result, address: { serverId: 'home-a', sessionId: 'session-one' } })).toMatchObject({
      itemId: input.itemId, itemRevision: revision, itemDestination: 'transcript',
    });
  });
  it('shows the guided Daily usage widget through the projected agent tool and saves its native definition', async () => {
    accountSettingsBody = allowedVisualPolicy;
    const tool = listBuiltInHappierTools({ surface: 'agent', actionsSettings: null, isActionEnabled: () => true })
      .find(candidate => candidate.actionId === 'session.board.item.upsert');
    expect(tool).toBeDefined();
    const prompt = buildHappierToolsPromptAppendix({ sessionId: 'session-one', directory: '/workspace' });
    const command = [...prompt.matchAll(/`([^`\n]+)`/g)]
      .map(match => parseTrustedHappierToolsShellBridgeCommand(match[1]!))
      .find(value => value?.kind === 'call' && value.tool === tool!.name
        && value.argsJson && JSON.parse(value.argsJson).itemId === 'daily-usage');
    expect(command).toMatchObject({ kind: 'call', tool: tool!.name, sessionId: 'session-one' });
    if (command?.kind !== 'call' || !command.argsJson) throw new Error('Missing Daily usage command');
    const input = JSON.parse(command.argsJson);
    const projected = tool!.inputSchema as z.ZodMiniType;
    expect(projected.safeParse(input).success).toBe(true);
    let committed: unknown;
    app.get('/v2/sessions/session-one/system-records/record', async request => {
      const mutation = committed ? SessionBoardMutationV1Schema.parse(committed) : null;
      return { record: (request.query as Record<string, string>).kind !== 'item.v1' || mutation?.operation !== 'upsert_item' ? null : {
        id: 'daily-usage-record', address: { owner: 'host', namespace: 'surface', kind: 'item.v1', localId: 'daily-usage' },
        revision, content: mutation.itemContent, createdAt: '2026-10-12T00:00:00.000Z', updatedAt: '2026-10-12T00:00:00.000Z',
      } };
    });
    app.put('/v2/sessions/session-one/board', async request => {
      committed = request.body;
      return { operation: 'upsert_item', itemId: input.itemId, outcome: 'created', itemRevision: revision };
    });
    // Exercise the real Account-backed factory, including widget scope/input
    // admission. A Board-only executor cannot admit configured widget inputs.
    const runtime = createHappierMcpServer({ sessionId: 'session-one',
      getServerBinding: () => ({ serverId: 'home-a', serverUrl: 'http://board.test' }),
      getServerFeaturesSnapshot: () => ({ status: 'ready', provenance: 'authenticated', features: FeaturesResponseSchema.parse({
        features: { sessions: { enabled: true, board: { enabled: true } }, sharing: { session: { enabled: true } } }, capabilities: {},
      }) }),
      rpcHandlerManager: new RpcHandlerManager({ scopePrefix: 'session-one', encryptionMode: 'plain' }),
      updateMetadata() {}, getMetadataSnapshot: () => createTestMetadata(), getWorkDepth: () => 0, getHostTurnWorkDepth: () => 0,
      getActiveTurnPermissionWitness: () => ({ turnId: 'turn', causalPermissionAuthority: {
        kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'default',
      } }), getStoredContentEncryptionContext: () => ({ mode: 'plain' }),
    }, { authorityScope: 'account', accountSettings: accountSettingsParse(accountSettingsBody), credentials: { token: `fixture.${Buffer.from(JSON.stringify({
      sub: 'account', provenance: { v: 1, kind: 'account', authority: 'present_user' },
    })).toString('base64url')}.signature`, encryption: null } });
    const client = new Client({ name: 'usage-agent', version: '1' });
    const [agentTransport, hostTransport] = InMemoryTransport.createLinkedPair();
    let result;
    try {
      await runtime.mcp.connect(hostTransport); await client.connect(agentTransport); await client.listTools();
      result = await client.callTool({ name: tool!.name, arguments: input }, CallToolResultSchema);
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
    } finally { await client.close(); await runtime.mcp.close(); }
    expect(committed).toMatchObject({ itemId: 'daily-usage', itemContent: { t: 'plain', v: {
      destination: 'transcript', source: { kind: 'widget', instance: {
        id: 'daily-usage', definition: { kind: 'builtin', id: 'usage_daily' },
      } },
    } } });
    expect(committed).not.toHaveProperty('placement');
    expect(resolveTranscriptSessionBoardItemReferenceV1({ toolName: tool!.name, state: 'completed', input,
      result, address: { serverId: 'home-a', sessionId: 'session-one' } })).toMatchObject({
      itemId: 'daily-usage', itemRevision: revision, itemDestination: 'transcript',
    });
    // Model Artifact persistence only; source acquisition, native promotion,
    // codecs, Action execution and the projected tool dispatcher remain real.
    const artifacts = new Map<string, WidgetDefinitionArtifactV1>();
    const deps: ActionExecutorDeps = { ...createUnavailableActionTransportDeps(),
      ...createSessionBoardActionDeps({ credentials: { token: 'token', encryption: null },
        serverId: 'home-a', serverHttpBaseUrl: 'http://board.test' }),
      widgetAccountScope: () => ({ serverId: 'home-a', accountId: 'account' }),
    };
    Object.assign(deps, createCliWidgetDefinitionActionDepsV1({ accountId: 'account', getDeps: () => deps,
      readCandidates: async () => [], transport: {
        read: async id => artifacts.get(id) ?? null,
        list: async () => ({ items: [] }),
        create: async args => {
          const row = { artifactId: args.artifactId, ownerAccountId: 'account', header: args.header, body: args.body,
            revision: { headerVersion: 1, bodyVersion: 1 } };
          artifacts.set(args.artifactId, row);
          return { artifactId: args.artifactId, revision: row.revision };
        },
        update: async () => { throw new Error('Save must create an independent definition'); },
        delete: async () => { throw new Error('Save must retain the Session visual'); },
      } }));
    const executor = createActionExecutor(deps);
    // This content test executes an already-admitted Save. The approval owner
    // has separate agent Save admission coverage.
    const saveTools = createActionToolExecutorBridge({ surface: 'agent', executor: {
      execute: (id, value, context) => executor.execute(id, value, { ...context, serverId: 'home-a',
        authority: 'present_user', bypassApprovals: true }),
    } });
    const saved = await saveTools.executeActionByToolName('action_execute', {
      actionId: 'widgets.definition.saveFromSession', input: { account: { serverId: 'home-a', accountId: 'account' },
        session: { serverId: 'home-a', sessionId: 'session-one' }, itemId: 'daily-usage', artifactId: '1b9f9a7d-adcf-4415-82fb-b68b62e731b2' },
    }, 'session-one');
    expect(saved, JSON.stringify(saved)).toMatchObject({ ok: true, result: { definition: { id: '1b9f9a7d-adcf-4415-82fb-b68b62e731b2',
      body: { kind: 'builtin', id: 'usage_daily' } }, suggestedBindings: input.item.source.instance.bindings } });
    expect(artifacts.get('1b9f9a7d-adcf-4415-82fb-b68b62e731b2')?.body).toBeDefined();
  });
  it('refuses a copy source outside the external credential Session grant before reading it', async () => {
    let sourceReads = 0;
    let writes = 0;
    const requests: string[] = [];
    app.addHook('onRequest', async request => { requests.push(request.url); });
    app.get('/v2/sessions/source-session', async () => { sourceReads++; return { session: { ...rawSession, id: 'source-session' } }; });
    app.get('/v2/sessions/source-session/system-records/record', async request => ({ record: (request.query as Record<string, string>).kind === 'layout.v1' ? null : {
      id: 'source-row', address: { owner: 'host', namespace: 'surface', kind: 'item.v1', localId: 'source-visual' },
      revision, content: { t: 'plain', v: item }, createdAt: '2026-09-05T00:00:00.000Z', updatedAt: '2026-09-05T00:00:00.000Z',
    } }));
    app.get('/v2/sessions/session-one/system-records/record', async () => ({ record: null }));
    app.put('/v2/sessions/session-one/board', async () => { writes++; return { operation: 'upsert_item', itemId: 'copied-visual', outcome: 'created', itemRevision: revision }; });
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), ...createSessionBoardActionDeps({ credentials: { token: 'token', encryption: null },
      serverId: 'home-a', serverHttpBaseUrl: 'http://board.test' }) });
    const result = await executor.execute('session.board.item.upsert', { sessionId: 'session-one', itemId: 'copied-visual',
      expectedItemRevision: null, copySource: { serverId: 'home-a', sessionId: 'source-session', itemId: 'source-visual', expectedItemRevision: revision } },
    { surface: 'cli', authority: 'present_user', serverId: 'home-a', defaultSessionId: 'session-one',
      presentUserConfirmation: { actionId: 'session.board.item.upsert' }, externalActionCredential: {
        accountId: 'account', principalId: 'token', credentialId: 'token',
        grant: { ...API_TOKEN_FULL_GRANT_V1, targets: { sessions: ['session-one'], machines: [] } },
      } });
    expect(sourceReads).toBe(0);
    expect(writes).toBe(0);
    expect(result, JSON.stringify({ requests, result })).toMatchObject({ ok: false, errorCode: 'credential_scope_denied' });
  });
  it('copies an exact other-Session visual through the canonical Action without retaining source ownership or widening network', async () => {
    const sourceItem = { ...item, source: { kind: 'hostedHtml', source: { v: 1, entrypoint: 'index.html', files: {
      'index.html': { mime: 'text/html', contentBase64: Buffer.from('<main>Source snapshot</main>').toString('base64') },
    } }, requestedCapabilities: { network: 'open', networkOrigins: [] } } };
    app.get('/v2/sessions/source-session', async () => ({ session: { ...rawSession, id: 'source-session' } }));
    app.get('/v2/sessions/source-session/system-records/record', async request => ({ record: (request.query as Record<string, string>).kind === 'layout.v1' ? null : {
      id: 'source-row', address: { owner: 'host', namespace: 'surface', kind: 'item.v1', localId: 'source-visual' },
      revision, content: { t: 'plain', v: sourceItem }, createdAt: '2026-09-05T00:00:00.000Z', updatedAt: '2026-09-05T00:00:00.000Z',
    } }));
    app.get('/v2/sessions/session-one/system-records/record', async () => ({ record: null }));
    let committed: unknown;
    app.put('/v2/sessions/session-one/board', async request => {
      committed = request.body;
      return { operation: 'upsert_item', itemId: 'copied-visual', outcome: 'created', itemRevision: revision };
    });
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), ...createSessionBoardActionDeps({ credentials: { token: 'token', encryption: null },
      serverId: 'home-a', serverHttpBaseUrl: 'http://board.test' }), readAgentHtmlNetworkPolicy: async () => 'off' });
    const result = await executor.execute('session.board.item.upsert', { sessionId: 'session-one', itemId: 'copied-visual',
      expectedItemRevision: null, destination: 'transcript', copySource: {
        serverId: 'home-a', sessionId: 'source-session', itemId: 'source-visual', expectedItemRevision: revision,
      } }, { surface: 'cli', authority: 'present_user', serverId: 'home-a', defaultSessionId: 'session-one',
      presentUserConfirmation: { actionId: 'session.board.item.upsert' } });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result).toMatchObject({ ok: true, result: { itemDestination: 'transcript', result: { outcome: 'created', itemId: 'copied-visual' },
      effectiveNetwork: { network: 'open', networkOrigins: [] } } });
    expect(committed).toMatchObject({ itemId: 'copied-visual', destination: 'transcript', itemContent: { t: 'plain', v: {
      ...sourceItem, destination: 'transcript',
    } } });
    expect(sourceItem.destination).toBe('board');
  });
  it('refuses stale, same-Session and foreign-Home copy sources before a destination write', async () => {
    let sourceReadable = true;
    app.get('/v2/sessions/source-session', async (_request, reply) => sourceReadable
      ? { session: { ...rawSession, id: 'source-session' } }
      : reply.code(403).send({ error: 'session_forbidden' }));
    app.get('/v2/sessions/source-session/system-records/record', async request => ({ record: (request.query as Record<string, string>).kind === 'layout.v1' ? null : {
      id: 'source-row', address: { owner: 'host', namespace: 'surface', kind: 'item.v1', localId: 'source-visual' },
      revision, content: { t: 'plain', v: item }, createdAt: '2026-09-05T00:00:00.000Z', updatedAt: '2026-09-05T00:00:00.000Z',
    } }));
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), ...createSessionBoardActionDeps({ credentials: { token: 'token', encryption: null },
      serverId: 'home-a', serverHttpBaseUrl: 'http://board.test' }) });
    const ctx = { surface: 'cli', authority: 'present_user', serverId: 'home-a', defaultSessionId: 'session-one',
      presentUserConfirmation: { actionId: 'session.board.item.upsert' as const } } as const;
    const input = { sessionId: 'session-one', itemId: 'copied-visual', expectedItemRevision: null, copySource: {
      serverId: 'home-a', sessionId: 'source-session', itemId: 'source-visual', expectedItemRevision: revision,
    } };
    expect(await executor.execute('session.board.item.upsert', { ...input, copySource: {
      ...input.copySource, expectedItemRevision: 'ssr1.AAAACHN5c3JlY18xAAAAAg',
    } }, ctx)).toMatchObject({ ok: false, errorCode: 'session_board_revision_conflict' });
    expect(await executor.execute('session.board.item.upsert', { ...input, copySource: {
      ...input.copySource, sessionId: 'session-one',
    } }, ctx)).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    expect(await executor.execute('session.board.item.upsert', { ...input, copySource: {
      ...input.copySource, serverId: 'other-home',
    } }, ctx)).toMatchObject({ ok: false, errorCode: 'server_target_mismatch' });
    sourceReadable = false;
    expect(await executor.execute('session.board.item.upsert', input, ctx)).toMatchObject({ ok: false, errorCode: 'not_authenticated' });
  });
  it('rekeys an inline widget and its definition while preserving independent destination bindings', async () => {
    const sourceItem = { ...item, source: { kind: 'widget', instance: { v: 1, id: 'source-visual',
      definition: { kind: 'inline', definition: { v: 1, id: 'source-definition', name: 'Source widget',
        body: { kind: 'declarative', document: item.source.document }, inputs: { fields: [] },
        inputSchema: { type: 'object', additionalProperties: false }, sizeDeclaration: { sizes: ['medium'], defaultSize: 'medium' },
        provenance: { source: { kind: 'authored' } } } }, bindings: {} } } };
    app.get('/v2/sessions/source-session', async () => ({ session: { ...rawSession, id: 'source-session' } }));
    app.get('/v2/sessions/source-session/system-records/record', async request => ({ record: (request.query as Record<string, string>).kind === 'layout.v1' ? null : {
      id: 'source-row', address: { owner: 'host', namespace: 'surface', kind: 'item.v1', localId: 'source-visual' },
      revision, content: { t: 'plain', v: sourceItem }, createdAt: '2026-09-05T00:00:00.000Z', updatedAt: '2026-09-05T00:00:00.000Z',
    } }));
    app.get('/v2/sessions/session-one/system-records/record', async () => ({ record: null }));
    let committed: unknown;
    app.put('/v2/sessions/session-one/board', async request => {
      committed = request.body;
      return { operation: 'upsert_item', itemId: 'copied-widget', outcome: 'created', itemRevision: revision };
    });
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), ...createSessionBoardActionDeps({ credentials: { token: 'token', encryption: null },
      serverId: 'home-a', serverHttpBaseUrl: 'http://board.test' }), widgetAccountScope: () => ({ serverId: 'home-a', accountId: 'account' }),
      widgetInputs: createWidgetActionInputResolverV1({ readDescriptor: async request => request.instance.definition.kind === 'inline'
        ? request.instance.definition.definition : null, readContext: async () => ({}), readViewerValues: async () => ({ values: {} }),
        validateValue: async () => ({ status: 'valid' }), resolveOptions: async () => [] }),
    });
    const result = await executor.execute('session.board.item.upsert', { sessionId: 'session-one', itemId: 'copied-widget',
      expectedItemRevision: null, copySource: { serverId: 'home-a', sessionId: 'source-session', itemId: 'source-visual', expectedItemRevision: revision } },
      { surface: 'cli', authority: 'present_user', serverId: 'home-a', defaultSessionId: 'session-one', presentUserConfirmation: { actionId: 'session.board.item.upsert' } });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(committed).toMatchObject({ itemContent: { t: 'plain', v: { destination: 'transcript', source: { kind: 'widget', instance: {
      id: 'copied-widget', definition: { kind: 'inline', definition: { id: 'copied-widget', body: sourceItem.source.instance.definition.definition.body } }, bindings: {},
    } } } } });
    expect(sourceItem.source.instance.id).toBe('source-visual');
    expect(sourceItem.source.instance.definition.definition.id).toBe('source-definition');
  });
  it('freezes a reviewed copy across source removal and refuses an authored copy-proof spoof', async () => {
    const sourceItem = { ...item, source: { kind: 'hostedHtml', source: { v: 1, entrypoint: 'index.html', files: {
      'index.html': { mime: 'text/html', contentBase64: Buffer.from('<main>Reviewed source</main>').toString('base64') },
    } }, requestedCapabilities: { network: 'open', networkOrigins: [] } } };
    let removed = false;
    app.get('/v2/sessions/source-session', async () => ({ session: { ...rawSession, id: 'source-session' } }));
    app.get('/v2/sessions/source-session/system-records/record', async request => ({ record: removed || (request.query as Record<string, string>).kind === 'layout.v1' ? null : {
      id: 'source-row', address: { owner: 'host', namespace: 'surface', kind: 'item.v1', localId: 'source-visual' },
      revision, content: { t: 'plain', v: sourceItem }, createdAt: '2026-09-05T00:00:00.000Z', updatedAt: '2026-09-05T00:00:00.000Z',
    } }));
    app.get('/v2/sessions/session-one/system-records/record', async () => ({ record: null }));
    let committed: unknown;
    app.put('/v2/sessions/session-one/board', async request => {
      committed = request.body;
      return { operation: 'upsert_item', itemId: 'copied-visual', outcome: 'created', itemRevision: revision };
    });
    // Only the approval Artifact persistence/HTTP boundary is replaced. Its
    // schema, approval decisions, origin binding and replay remain real.
    let approval: unknown;
    app.post('/test/approval', async request => { approval = request.body; return { artifactId: 'copy-approval' }; });
    app.get('/test/approval', async () => approval);
    app.put('/test/approval', async request => { approval = request.body; return { ok: true }; });
    const deps: ActionExecutorDeps = { ...createUnavailableActionTransportDeps(), ...createSessionBoardActionDeps({ credentials: { token: 'token', encryption: null },
      serverId: 'home-a', serverHttpBaseUrl: 'http://board.test' }), readAgentHtmlNetworkPolicy: async () => 'off',
      approvalsCreate: async ({ request }) => (await axios.post<{ artifactId: string }>('http://board.test/test/approval', request)).data,
      approvalsGet: async () => (await axios.get<Awaited<ReturnType<NonNullable<ActionExecutorDeps['approvalsGet']>>>>('http://board.test/test/approval')).data,
      approvalsUpdate: async ({ request }) => (await axios.put<{ ok: true }>('http://board.test/test/approval', request)).data,
      isApprovalExecutionOriginCurrent: async () => true,
    };
    const executor = createActionExecutor(deps);
    const input = { sessionId: 'session-one', itemId: 'copied-visual', expectedItemRevision: null, copySource: {
      serverId: 'home-a', sessionId: 'source-session', itemId: 'source-visual', expectedItemRevision: revision,
    } };
    const ctx = { surface: 'agent', authority: 'account_automation', serverId: 'home-a', defaultSessionId: 'session-one',
      runtimeAccountId: 'account', actionRequestId: 'copy-request', defaultSessionMachineId: 'machine-one',
      actionCaller: { kind: 'session', sessionId: 'session-one', starterDepth: 0, turnDepth: 0 } } as const;
    expect(await executor.execute('session.board.item.upsert', input, ctx)).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
    expect(committed).toBeUndefined();
    removed = true;
    const decided = await executor.execute('approval.request.decide', { artifactId: 'copy-approval', decision: 'approve' },
      { surface: 'ui', authority: 'present_user', serverId: 'home-a' });
    expect(decided).toMatchObject({ ok: true });
    expect(committed, JSON.stringify(decided)).toBeDefined();
    expect(committed).toMatchObject({ itemContent: { t: 'plain', v: { source: sourceItem.source, destination: 'transcript' } } });
    expect(await executor.execute('session.board.item.upsert', { sessionId: 'session-one', itemId: 'forged',
      expectedItemRevision: null, item: sourceItem, copySource: input.copySource }, ctx)).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
  });
  it('acquires workspace HTML before approval preparation and keeps the acquired bytes for the later mutation', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'happier-visual-preparation-'));
    try {
      const path = join(workspaceRoot, 'index.html');
      await writeFile(path, '<main>Reviewed</main>');
      const deps = createSessionBoardActionDeps({ credentials: { token: 'token', encryption: null },
        serverId: 'home-a', serverHttpBaseUrl: 'http://board.test',
        resolvePublishCaller: async () => ({ sessionId: 'session-one', machineId: 'machine-one', directory: workspaceRoot }),
      });
      const prepared = await deps.sessionBoardPrepareItem!({ context: { defaultSessionId: 'session-one' }, input: {
        itemId: 'page', expectedItemRevision: null, destination: 'transcript', item: { ...item,
          source: { kind: 'hostedHtml', publicationSource: { path: 'index.html' } } },
      } });
      expect(prepared).toMatchObject({ item: { source: { kind: 'hostedHtml', source: { entrypoint: 'index.html' } } } });
      await writeFile(path, '<main>Changed after review</main>');
      app.get('/v2/sessions/session-one/system-records/record', async () => ({ record: null }));
      let committed: unknown;
      app.put('/v2/sessions/session-one/board', async request => {
        committed = request.body;
        return { operation: 'upsert_item', itemId: 'page', outcome: 'created', itemRevision: revision };
      });
      await expect(deps.sessionBoardAction!({ actionId: 'session.board.item.upsert', context: { defaultSessionId: 'session-one' }, input: prepared }))
        .resolves.toMatchObject({ result: { outcome: 'created' } });
      expect(JSON.stringify(committed)).toContain(Buffer.from('<main>Reviewed</main>').toString('base64'));
      expect(JSON.stringify(committed)).not.toContain(Buffer.from('<main>Changed after review</main>').toString('base64'));
    } finally { await rm(workspaceRoot, { recursive: true, force: true }); }
  });
  it('reads explicit transcript items when Board is disabled without reading layout', async () => {
    app.get('/v2/sessions/session-one/system-records/record', async request => {
      expect((request.query as Record<string, string>).kind).toBe('item.v1');
      return { record: null };
    });
    const deps = createSessionBoardActionDeps({ credentials: { token: 'daemon-token', encryption: null },
      serverHttpBaseUrl: 'http://board.test', serverId: 'home-a',
      resolveServerFeaturesSnapshot: () => ({ status: 'ready', features: FeaturesResponseSchema.parse({
        features: { sessions: { enabled: true, board: { enabled: false } } }, capabilities: {},
      }) }),
    });
    await expect(deps.sessionBoardAction!({ actionId: 'session.board.get', context: {}, input: {
      sessionId: 'session-one', itemIds: ['visual'],
    } })).resolves.toMatchObject({ layout: null, items: [], incomplete: true });
  });
  it('creates transcript content with Board disabled without reading layout and returns a small destination acknowledgement', async () => {
    app.get('/v2/sessions/session-one/system-records/record', async request => {
      expect((request.query as Record<string, string>).kind).toBe('item.v1');
      return { record: null };
    });
    let mutation: unknown;
    app.put('/v2/sessions/session-one/board', async request => {
      mutation = request.body;
      return { operation: 'upsert_item', itemId: 'visual', outcome: 'created', itemRevision: revision };
    });
    const deps = createSessionBoardActionDeps({ credentials: { token: 'daemon-token', encryption: null },
      serverHttpBaseUrl: 'http://board.test', serverId: 'home-a',
      resolveServerFeaturesSnapshot: () => ({ status: 'ready', features: FeaturesResponseSchema.parse({
        features: { sessions: { enabled: true, board: { enabled: false } }, sharing: { session: { enabled: true } } }, capabilities: {},
      }) }),
    });
    await expect(deps.sessionBoardAction!({ actionId: 'session.board.item.upsert', context: {}, input: {
      sessionId: 'session-one', itemId: 'visual', expectedItemRevision: null, item,
    } })).resolves.toEqual({ v: 1, serverId: 'home-a', sessionId: 'session-one', itemDestination: 'transcript', destination: null,
      result: { operation: 'upsert_item', itemId: 'visual', itemRevision: revision, outcome: 'created' } });
    expect(mutation).toEqual({ operation: 'upsert_item', itemId: 'visual', expectedItemRevision: null, destination: 'transcript',
      itemContent: { t: 'plain', v: { ...item, destination: 'transcript' } } });
  });
  it.each([
    { surface: 'agent', networkPolicy: 'allowed' }, { surface: 'session-agent', networkPolicy: 'allowed' },
    { surface: 'cli', networkPolicy: 'allowed' }, { surface: 'admitted-cli', networkPolicy: 'allowed' },
    { surface: 'agent', networkPolicy: 'off' },
  ] as const)('publishes a confined workspace folder through the composed $surface Session Action with $networkPolicy network policy without creating an Artifact', async ({ surface, networkPolicy }) => {
    accountSettingsBody = { ...allowedVisualPolicy, agentHtmlNetworkPolicy: networkPolicy };
    const directory = await mkdtemp(join(tmpdir(), 'happier-session-html-'));
    try {
      const sessionId = 'c111111111111111111111111';
      const metadata = createTestMetadata({ path: directory, machineId: 'machine-one' });
      await writeSettings({ schemaVersion: SUPPORTED_SCHEMA_VERSION, onboardingCompleted: true,
        machineIdByServerId: { [configuration.activeServerId]: 'machine-one' } });
      const token = surface === 'session-agent' ? 'runner-session-token' : `fixture.${Buffer.from(JSON.stringify({ sub: 'account',
        provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`;
      const credentials = { token, encryption: null };
      const keys = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(19));
      const target = { kind: 'machine' as const, machineId: 'machine-one' };
      const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'folder-authority', binding: {
        accountId: 'account', authentication: { kind: 'account', tokenEpoch: 0 }, accountEncryptionMode: 'plain',
        serverIdentityId: 'srv_folder_home', machineId: target.machineId, custodianAccountId: 'account', installationId: 'folder-installation',
        actionId: 'session.board.item.upsert', requestId: 'folder-request', target, requestEnvelopeDigest: 'a'.repeat(43),
      } });
      const verifyAuthorization = (request: Readonly<{ headers: Record<string, unknown>; url: string; method: string; body?: unknown }>) => {
        if (surface !== 'admitted-cli') { expect(request.headers.authorization).toBe(`Bearer ${token}`); return; }
        expect(request.headers.authorization).toBeUndefined();
        expect(request.headers[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]).toBe(authorization.token);
        expect(verifyExternalActionMachineRequestV1({ authorizationToken: authorization.token,
          effectActionId: 'session.board.item.upsert', target, installationId: 'folder-installation', requestId: 'folder-request',
          method: request.method, path: request.url, body: request.body, publicKey: keys.publicKey,
          signature: String(request.headers[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]) })).toBe(true);
      };
      await mkdir(join(directory, 'site'));
      await writeFile(join(directory, 'site', 'index.html'), '<script src="main.js"></script>');
      await writeFile(join(directory, 'site', 'main.js'), 'document.body.dataset.loaded="yes"');
      app.get(`/v2/sessions/${sessionId}`, async request => { verifyAuthorization(request);
        return { session: { ...rawSession, id: sessionId, metadata: JSON.stringify(metadata) } }; });
      verifyAccountRequest = verifyAuthorization;
      app.get(`/v2/sessions/${sessionId}/system-records/record`, async request => { verifyAuthorization(request); return { record: null }; });
      const writes: unknown[] = [];
      app.put(`/v2/sessions/${sessionId}/board`, async (request) => {
        verifyAuthorization(request);
        writes.push(request.body);
        return { operation: 'upsert_item', itemId: 'result', outcome: 'created', itemRevision: revision };
      });
      const input = { sessionId, itemId: 'result',
        expectedItemRevision: null, destination: 'transcript', item: { ...item, source: { kind: 'hostedHtml',
          publicationSource: { path: 'site', entrypoint: 'index.html' }, requestedCapabilities: { network: networkPolicy === 'off' ? 'open' : 'none' } } } };
      if (surface === 'agent' || surface === 'session-agent') {
        const runtime = createHappierMcpServer({ sessionId,
          getServerBinding: () => ({ serverId: 'home-a', serverUrl: 'http://board.test' }),
          getServerFeaturesSnapshot: () => ({ status: 'ready', provenance: 'authenticated', features: FeaturesResponseSchema.parse({
            features: { sessions: { enabled: true, board: { enabled: true } }, sharing: { session: { enabled: true } } }, capabilities: {},
          }) }),
          rpcHandlerManager: new RpcHandlerManager({ scopePrefix: sessionId, encryptionMode: 'plain' }),
          updateMetadata() {}, getMetadataSnapshot: () => metadata, getWorkDepth: () => 0, getHostTurnWorkDepth: () => 0,
          getActiveTurnPermissionWitness: () => ({ turnId: 'turn', causalPermissionAuthority: {
            kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'default',
          } }), getStoredContentEncryptionContext: () => ({ mode: 'plain' }),
        }, surface === 'session-agent' ? { authorityScope: 'session', credentials: null, sessionCredentials: credentials,
          actionsSettingsProvider: createScopedRuntimeActionSettingsProvider(normalizeActionsSettingsV1(allowedVisualPolicy.actionsSettingsV1)) }
          : { authorityScope: 'account', credentials, accountSettings: accountSettingsParse(accountSettingsBody) });
        const client = new Client({ name: 'folder-agent', version: '1' });
        const [agentTransport, hostTransport] = InMemoryTransport.createLinkedPair();
        try {
          await runtime.mcp.connect(hostTransport); await client.connect(agentTransport);
          const result = await client.callTool({ name: 'session_board_item_upsert', arguments: input }, CallToolResultSchema);
          expect(result.isError, JSON.stringify(result)).not.toBe(true);
          expect(result.structuredContent).toMatchObject({ itemDestination: 'transcript', result: { outcome: 'created' } });
          if (networkPolicy === 'off') expect(result.structuredContent).toMatchObject({
            effectiveNetwork: { network: 'none', networkOrigins: [] }, notices: [{ code: 'agent_html_network_off' }],
          });
          const retargeted = await client.callTool({ name: 'session_board_item_upsert', arguments: {
            ...input, sessionId: 'c222222222222222222222222',
          } }, CallToolResultSchema);
          expect(retargeted.isError).toBe(true);
          expect(writes).toHaveLength(1);
        } finally { await client.close(); await runtime.mcp.close(); }
      } else {
        const { executor } = createCliActionExecutorHarness({ credentials, token, sessionId: 'cli-global', mode: 'plain', ctx: null,
          serverId: 'home-a', serverHttpBaseUrl: 'http://board.test',
          ...(surface === 'admitted-cli' ? { serverIdentityId: 'srv_folder_home', externalActionMachineRequestPrivateKey: keys.secretKey,
            externalActionMachineInstallationId: 'folder-installation' } : {}),
        });
        const context = { surface: 'cli' as const, authority: 'present_user' as const, serverId: 'home-a',
          presentUserConfirmation: { actionId: 'session.board.item.upsert' as const },
          ...(surface === 'admitted-cli' ? { externalActionExecutionAuthorization: authorization, externalActionTarget: target } : {}),
        };
        const command = findCompiledActionCliCommand(['session', 'board', 'item', 'set']);
        if (!command) throw new Error('Missing public Session visual command');
        const bindItem = (value: unknown) => {
          const parsed = parseActionCliCommandInput(command, [...command.path, sessionId, input.itemId,
            '--destination', 'transcript', '--item-json', JSON.stringify(value)]);
          if (!parsed.ok) throw new Error(parsed.message);
          return composeActionCliInput({ parsed, canonicalSchema: command.spec.inputSchema,
            wholeInputSchema: command.wholeInputSchema, callerSchema: command.callerSchema,
            bindInput: command.spec.cli?.bindInput,
            context: { actionId: command.actionId, invocationId: 'folder-cli', commandPath: command.path } });
        };
        const inlineItem = { ...input.item, source: { kind: 'hostedHtml', source: {
          v: 1, entrypoint: 'index.html', files: { 'index.html': {
            mime: 'text/html', contentBase64: Buffer.from('<p>Inline HTML</p>').toString('base64'),
          } },
        } } };
        expect(bindItem(inlineItem)).toMatchObject({ ok: true, input: { expectedItemRevision: null, item: inlineItem } });
        const bound = bindItem(input.item);
        expect(bound).toMatchObject({ ok: true, input });
        if (!bound.ok) throw new Error(bound.message);
        const result = await executor.execute(command.actionId, bound.input, {
          ...context,
        });
        expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { itemDestination: 'transcript', result: { outcome: 'created' } } });
        const escaped = { ...input, item: { ...input.item, source: { ...input.item.source,
          publicationSource: { path: '../site', entrypoint: 'index.html' } } } };
        expect(await executor.execute('session.board.item.upsert', escaped, context)).toMatchObject({ ok: false });
        metadata.machineId = 'foreign-machine';
        expect(await executor.execute('session.board.item.upsert', input, context))
          .toMatchObject({ ok: false, errorCode: 'unsupported_action' });
        metadata.machineId = 'machine-one';
        rawSession.effectiveAccess = { v: 1, level: 'view', sources: [{ kind: 'direct', shareId: 'view-only' }],
          capabilities: projectSessionAccessCapabilitiesV1({ owner: false, grants: [{ accessLevel: 'view', canApprovePermissions: false }] }) };
        expect(await executor.execute('session.board.item.upsert', input, context)).toMatchObject({ ok: false });
        expect(writes).toHaveLength(1);
      }
      expect(writes).toEqual([expect.objectContaining({ itemContent: { t: 'plain', v: {
        ...item, destination: 'transcript', source: { kind: 'hostedHtml', source: { v: 1, entrypoint: 'index.html', files: {
          'index.html': { mime: 'text/html', contentBase64: Buffer.from('<script src="main.js"></script>').toString('base64') },
          'main.js': { mime: 'text/javascript', contentBase64: Buffer.from('document.body.dataset.loaded="yes"').toString('base64') },
        } }, requestedCapabilities: { network: 'none', networkOrigins: [] } },
      } } })]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it('refuses a captured layout mismatch before sealing a size upsert to an old view', async () => {
    const movedLayoutRevision = 'ssr1.AAAACHN5c3JlY18xAAAAAg';
    const layout = { v: 1, tabs: [{ id: 'old', title: 'Old', items: [] },
      { id: 'new', title: 'New', items: [{ itemId: 'status', width: 'full', frameStyle: 'plain' }] }] };
    let writes = 0;
    app.get('/v2/sessions/session-one/system-records/record', async request => {
      const kind = (request.query as Record<string, string>).kind;
      return { record: { id: kind === 'layout.v1' ? 'layout-row' : 'item-row',
        address: { owner: 'host', namespace: 'surface', kind, localId: kind === 'layout.v1' ? 'layout' : 'status' },
        content: { t: 'plain', v: kind === 'layout.v1' ? layout : installed }, revision: kind === 'layout.v1' ? movedLayoutRevision : revision,
        createdAt: '2026-09-05T00:00:00.000Z', updatedAt: '2026-09-05T00:00:00.000Z' } };
    });
    app.put('/v2/sessions/session-one/board', async () => { writes++; throw new Error('Stale size must not be written'); });
    const deps = createSessionBoardActionDeps({ credentials: { token: 'daemon-token', encryption: null }, serverHttpBaseUrl: 'http://board.test', serverId: 'home-a' });
    await expect(deps.sessionBoardAction!({ actionId: 'session.board.item.upsert', context: {}, input: { sessionId: 'session-one',
      itemId: 'status', expectedItemRevision: revision, expectedLayoutRevision: revision,
      item: { ...installed, height: { mode: 'fixed', size: 'tall' } }, placement: { tabId: 'old', width: 'medium' } } }))
      .resolves.toMatchObject({ errorCode: 'session_board_revision_conflict' });
    expect(writes).toBe(0);
  });
  it('reads additive stored fields and keeps canonical writes and strict Action admission', async () => {
    const canonicalLayout = { v: 1, tabs: [{ id: 'overview', title: 'Overview', items: [{ itemId: 'status', width: 'wide' }] }] };
    const storedItem = { ...installed, extra: true, source: { ...installed.source, extra: true,
      instance: { ...installed.source.instance, extra: true, definition: { ...installed.source.instance.definition,
        surface: { ...installed.source.instance.definition.surface, extra: true } } } } };
    const storedLayout = { ...canonicalLayout, extra: true, tabs: [{ ...canonicalLayout.tabs[0], extra: true,
      items: [{ ...canonicalLayout.tabs[0].items[0], extra: true }] }] };
    expect(() => validateSessionSystemRecordOpenedContent({ owner: 'host', namespace: 'surface', kind: 'item.v1', localId: 'status' },
      storedItem, 'plugin_session_record_invalid_request')).toThrow();
    app.get('/v2/sessions/session-one/system-records/record', async (request) => {
      const kind = (request.query as Record<string, string>).kind;
      return { record: { id: kind === 'layout.v1' ? 'layout-row' : 'item-row',
        address: { owner: 'host', namespace: 'surface', kind, localId: kind === 'layout.v1' ? 'layout' : 'status' },
        content: { t: 'plain', v: kind === 'layout.v1' ? storedLayout : storedItem }, revision,
        createdAt: '2026-09-05T00:00:00.000Z', updatedAt: '2026-09-05T00:00:00.000Z' } };
    });
    const writes: unknown[] = [];
    app.put('/v2/sessions/session-one/board', async (request) => {
      writes.push(request.body);
      return { operation: 'upsert_item', itemId: 'status', outcome: 'updated', itemRevision: revision, layoutRevision: revision };
    });
    const deps = createSessionBoardActionDeps({ credentials: { token: 'daemon-token', encryption: null },
      serverId: 'home-a', serverHttpBaseUrl: 'http://board.test' });
    const context = { surface: 'cli' as const, authority: 'present_user' as const, serverId: 'home-a' };
    await expect(deps.sessionBoardAction!({ actionId: 'session.board.get', context,
      input: { sessionId: 'session-one', itemIds: ['status'] } }))
      .resolves.toMatchObject({ layout: { document: canonicalLayout }, items: [{ item: installed }], incomplete: false });
    const input = { sessionId: 'session-one', itemId: 'status', expectedItemRevision: revision, item: installed,
      placement: { tabId: 'overview', width: 'wide' as const } };
    await expect(deps.sessionBoardAction!({ actionId: 'session.board.item.upsert', context, input }))
      .resolves.toMatchObject({ result: { outcome: 'updated' } });
    expect(writes).toEqual([expect.objectContaining({ itemContent: { t: 'plain', v: installed },
      placement: { expectedLayoutRevision: revision, layoutContent: { t: 'plain', v: canonicalLayout } } })]);
    await expect(deps.sessionBoardAction!({ actionId: 'session.board.item.upsert', context,
      input: { ...input, item: storedItem } })).resolves.toMatchObject({ ok: false });
    expect(writes).toHaveLength(1);
  });
  it('rejects a partially qualified fixed Home before constructing the transport', () => {
    expect(() => createSessionBoardActionDeps({
      credentials: { token: 'token', encryption: null },
      serverId: 'home-a',
    } as unknown as Parameters<typeof createSessionBoardActionDeps>[0])).toThrow('fixed_action_server_target_incomplete');
    expect(() => createSessionBoardActionDeps({
      credentials: { token: 'token', encryption: null },
      serverHttpBaseUrl: 'http://board.test',
    } as unknown as Parameters<typeof createSessionBoardActionDeps>[0])).toThrow('fixed_action_server_target_incomplete');
  });
  it.each([
    ['direct', { kind: 'direct' as const, shareId: 'share-1' }],
    ['Team', { kind: 'team' as const, teamId: 'team-1', requiredByTeamPolicy: true }],
    ['Group', { kind: 'group' as const, teamId: 'team-1', groupId: 'group-1' }],
  ])('uses current exact-Home detail for %s access before reading Board state', async (_label, source) => {
    rawSession.effectiveAccess = {
      v: 1,
      level: 'edit',
      sources: [source],
      capabilities: projectSessionAccessCapabilitiesV1({
        owner: false,
        grants: [{ accessLevel: 'edit', canApprovePermissions: false }],
      }),
    };
    verifySessionRequest = (request) => {
      expect((request as { query?: unknown }).query).toEqual({ accessProjectionVersion: '1' });
    };
    app.get('/v2/sessions/session-one/system-records/record', async () => ({ record: null }));
    app.get('/v2/sessions/session-one/system-records', async () => ({ records: [], nextCursor: null, hasNext: false }));

    const deps = createSessionBoardActionDeps({
      credentials: { token: 'daemon-token', encryption: null },
      serverId: 'home-a',
      serverHttpBaseUrl: 'http://board.test',
    });
    await expect(deps.sessionBoardAction!({
      actionId: 'session.board.get',
      input: { sessionId: 'session-one' },
      context: { surface: 'cli', authority: 'present_user', serverId: 'home-a' },
    })).resolves.toMatchObject({ serverId: 'home-a', sessionId: 'session-one', items: [] });
  });
  it.each([
    ['direct', { kind: 'direct' as const, shareId: 'share-1' }],
    ['Team-only', { kind: 'team' as const, teamId: 'team-1', requiredByTeamPolicy: false }],
    ['Group-only', { kind: 'group' as const, teamId: 'team-1', groupId: 'group-1' }],
  ])('uses the injected exact-Home snapshot for %s current detail without ambient probing', async (_label, source) => {
    rawSession.effectiveAccess = {
      v: 1,
      level: 'edit',
      sources: [source],
      capabilities: projectSessionAccessCapabilitiesV1({
        owner: false,
        grants: [{ accessLevel: 'edit', canApprovePermissions: false }],
      }),
    };
    const serverSnapshot = {
      status: 'ready' as const,
      features: {
        features: {
          sessions: { enabled: true, board: { enabled: true } },
          sharing: { session: { enabled: true } },
        },
        capabilities: {},
      },
    };
    verifySessionRequest = (request) => {
      expect((request as { query?: unknown }).query).toEqual({ accessProjectionVersion: '1' });
    };
    app.get('/v2/sessions/session-one/system-records/record', async () => ({ record: null }));
    app.get('/v2/sessions/session-one/system-records', async () => ({ records: [], nextCursor: null, hasNext: false }));
    const fetchSpy = vi.mocked(globalThis.fetch);
    fetchSpy.mockClear();
    const deps = createSessionBoardActionDeps({
      credentials: { token: 'daemon-token', encryption: null },
      serverId: 'home-a',
      serverHttpBaseUrl: 'http://board.test',
      resolveServerFeaturesSnapshot: async () => serverSnapshot as never,
    });
    await expect(deps.sessionBoardAction!({
      actionId: 'session.board.get',
      input: { sessionId: 'session-one' },
      context: { surface: 'cli', authority: 'present_user', serverId: 'home-a' },
    })).resolves.toMatchObject({ serverId: 'home-a', sessionId: 'session-one', items: [] });
    // Exact-Home resolver owns the decision; no ambient feature probe may widen detail.
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it('keeps record-read failure categories the producer already answered', async () => {
    let recordReply: Readonly<{ status: number; body: unknown }> = { status: 200, body: { record: null } };
    let puts = 0;
    app.get('/v2/sessions/session-one/system-records/record', async (_request, reply) =>
      reply.status(recordReply.status).send(recordReply.body));
    app.put('/v2/sessions/session-one/board', async () => { puts += 1; return { ok: true }; });
    const deps = createSessionBoardActionDeps({
      credentials: { token: 'daemon-token', encryption: null },
      serverId: 'home-a',
      serverHttpBaseUrl: 'http://board.test',
    });
    const read = () => deps.sessionBoardAction!({
      actionId: 'session.board.get',
      input: { sessionId: 'session-one' },
      context: { surface: 'cli', authority: 'present_user', serverId: 'home-a' },
    });

    // A definite authorization denial stays `forbidden`, not "you are not signed in".
    recordReply = { status: 403, body: { error: 'Forbidden', code: 'plugin_session_record_forbidden' } };
    await expect(read()).resolves.toMatchObject({ ok: false, errorCode: 'forbidden' });
    // The typed feature refusal keeps its operation, exactly like the mutation settlement.
    recordReply = { status: 404, body: { error: 'Not found', code: 'plugin_session_record_feature_disabled' } };
    await expect(read()).resolves.toMatchObject({
      ok: false, errorCode: 'feature_disabled', details: { operation: 'session.board.get' },
    });
    recordReply = { status: 200, body: { malformed: 'private record payload' } };
    await expect(read()).resolves.toEqual({ ok: false, errorCode: 'invalid_response', error: 'invalid_response' });
    // A read that never reached the Home is `offline`, the same disposition the mutation path uses.
    const refused = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    const get = vi.spyOn(axios, 'get').mockRejectedValue(refused);
    await expect(read()).resolves.toMatchObject({ ok: false, errorCode: 'offline' });
    // Cancellation stays distinct from being offline.
    get.mockRejectedValue(Object.assign(new Error('canceled'), { code: 'ERR_CANCELED' }));
    await expect(read()).resolves.toMatchObject({ ok: false, errorCode: 'cancelled' });
    get.mockRejectedValue(new Error('private unexpected transport diagnostics'));
    await expect(read()).resolves.toEqual({ ok: false, errorCode: 'server_error', error: 'server_error' });
    get.mockRestore();
    expect(puts).toBe(0);
  });

  it('fails a supported old Home closed without appending a qualifier', async () => {
    verifySessionRequest = (request) => {
      expect((request as { query?: unknown }).query).toEqual({});
    };
    const deps = createSessionBoardActionDeps({
      credentials: { token: 'daemon-token', encryption: null },
      serverId: 'home-a',
      serverHttpBaseUrl: 'http://board.test',
      resolveServerFeaturesSnapshot: async () => ({
        status: 'unsupported',
        reason: 'endpoint_missing',
      }) as never,
    });
    const result = await deps.sessionBoardAction!({
      actionId: 'session.board.get',
      input: { sessionId: 'session-one' },
      context: { surface: 'cli', authority: 'present_user', serverId: 'home-a' },
    });
    expect(result).toMatchObject({ ok: false });
    // Old Home never qualifies Team/Group detail; at most a bare owner/direct read occurs.
  });
  it('signs every external Board Home read without sending the daemon bearer', async () => {
    const keyPair = tweetnacl.sign.keyPair();
    const target = { kind: 'session' as const, sessionId: 'session-one' };
    const authorization = {
      v: 1,
      token: 'execution-proof',
      binding: {
        serverIdentityId: 'home-a', accountId: 'account-1', principalId: 'principal-1', credentialId: 'credential-1',
        grant: API_TOKEN_FULL_GRANT_V1,
        machineId: 'machine-1', actionId: 'session.board.get', requestId: 'request-1',
        custodianAccountId: 'account-1', installationId: 'installation-1',
        requestEnvelopeDigest: 'd'.repeat(43), target,
      },
    } satisfies ExternalActionExecutionAuthorizationV1;
    const verify = (request: Readonly<{ headers?: unknown }>, method: string, path: string) => {
      const readHeader = (name: string): string | null => {
        if (request.headers instanceof Headers) return request.headers.get(name);
        if (!request.headers || typeof request.headers !== 'object') return null;
        const value = Reflect.get(request.headers, name) ?? Reflect.get(request.headers, name.toLowerCase());
        if (typeof value === 'string') return value;
        return Array.isArray(value) ? value.join(', ') : null;
      };
      expect(readHeader('authorization')).toBeNull();
      expect(readHeader(EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER)).toBe('execution-proof');
      expect(readHeader(EXTERNAL_ACTION_EFFECT_ACTION_HEADER)).toBe('session.board.get');
      expect(verifyExternalActionMachineRequestV1({
        authorizationToken: authorization.token,
        effectActionId: 'session.board.get',
        target,
        installationId: 'installation-1',
        requestId: authorization.binding.requestId,
        method,
        path,
        publicKey: keyPair.publicKey,
        signature: String(readHeader(EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER)),
      })).toBe(true);
    };
    vi.mocked(globalThis.fetch).mockImplementation(async (_url, init) => {
      verify({ headers: init?.headers }, 'GET', '/v1/features');
      return new Response(JSON.stringify({
        features: {
          sessions: { enabled: true, board: { enabled: true } },
          sharing: { session: { enabled: true } },
        },
        capabilities: {},
      }));
    });
    verifySessionRequest = (request) => {
      verify(request, 'GET', '/v2/sessions/session-one?accessProjectionVersion=1');
      expect(request.query).toEqual({ accessProjectionVersion: '1' });
    };
    app.get('/v2/sessions/session-one/system-records/record', async (request) => {
      const query = request.query as Record<string, string>;
      const path = `/v2/sessions/session-one/system-records/record?${new URLSearchParams(query).toString()}`;
      verify(request, 'GET', path);
      return { record: null };
    });
    app.get('/v2/sessions/session-one/system-records', async (request) => {
      const query = request.query as Record<string, string>;
      const path = `/v2/sessions/session-one/system-records?${new URLSearchParams(query).toString()}`;
      verify(request, 'GET', path);
      return { records: [], nextCursor: null, hasNext: false };
    });
    const deps = createSessionBoardActionDeps({
      credentials: { token: 'daemon-token', encryption: null },
      serverId: 'home-a',
      serverIdentityId: 'home-a',
      serverHttpBaseUrl: 'http://board.test',
      externalActionMachineRequestPrivateKey: keyPair.secretKey,
      externalActionMachineInstallationId: 'installation-1',
    });
    await expect(deps.sessionBoardAction!({
      actionId: 'session.board.get',
      context: {
        externalActionCredential: { accountId: 'account-1', principalId: 'principal-1', credentialId: 'credential-1', grant: authorization.binding.grant },
        externalActionExecutionAuthorization: authorization,
        externalActionTarget: target,
      },
      input: { sessionId: 'session-one' },
    })).resolves.toMatchObject({ serverId: 'home-a', sessionId: 'session-one', items: [] });
  });
  it('creates a current external widget reference through the exact signed Board writer and refuses retired shapes', async () => {
    const previousMetadata = rawSession.metadata;
    rawSession.metadata = JSON.stringify({ machineId: 'machine-session' });
    const keyPair = tweetnacl.sign.keyPair();
    const target = { kind: 'session' as const, sessionId: 'session-one' };
    const authorization = {
      v: 1,
      token: 'board-create-proof',
      binding: {
        serverIdentityId: 'home-a', accountId: 'account-1', principalId: 'principal-1', credentialId: 'credential-1',
        grant: API_TOKEN_FULL_GRANT_V1,
        machineId: 'machine-caller', actionId: 'session.board.item.upsert', requestId: 'board-create-request',
        custodianAccountId: 'account-1', installationId: 'installation-1',
        requestEnvelopeDigest: 'd'.repeat(43), target,
      },
    } satisfies ExternalActionExecutionAuthorizationV1;
    const context = {
      externalActionCredential: { accountId: 'account-1', principalId: 'principal-1', credentialId: 'credential-1', grant: authorization.binding.grant },
      externalActionExecutionAuthorization: authorization,
      externalActionTarget: target,
    };
    let writes = 0;
    const sessionQueries: unknown[] = [];
    verifySessionRequest = (request) => {
      sessionQueries.push((request as { query?: unknown }).query);
    };
    app.get('/v2/sessions/session-one/system-records/record', async () => ({ record: null }));
    app.put('/v2/sessions/session-one/board', async (request) => {
      writes += 1;
      expect(request.headers.authorization).toBeUndefined();
      expect(request.headers[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]).toBe(authorization.token);
      expect(verifyExternalActionMachineRequestV1({
        authorizationToken: authorization.token,
        effectActionId: 'session.board.item.upsert',
        target,
        installationId: 'installation-1',
        requestId: authorization.binding.requestId,
        method: 'PUT',
        path: '/v2/sessions/session-one/board',
        body: request.body,
        publicKey: keyPair.publicKey,
        signature: String(request.headers[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]),
      })).toBe(true);
      return { operation: 'upsert_item', itemId: 'status', outcome: 'created', itemRevision: revision, layoutRevision: revision };
    });
    try {
      const deps = createSessionBoardActionDeps({
        credentials: { token: 'daemon-token', encryption: null },
        serverId: 'home-a',
        serverIdentityId: 'home-a',
        serverHttpBaseUrl: 'http://board.test',
        externalActionMachineRequestPrivateKey: keyPair.secretKey,
        externalActionMachineInstallationId: 'installation-1',
      });
      const input = { sessionId: 'session-one', itemId: 'status', item: installed, expectedItemRevision: null, placement: { tabId: 'overview', tabTitle: 'Overview' } };
      await expect(deps.sessionBoardAction!({ actionId: 'session.board.item.upsert', context, input })).resolves.toMatchObject({ result: { outcome: 'created' } });
      await expect(deps.sessionBoardAction!({ actionId: 'session.board.item.upsert', context, input: {
        ...input,
        item: { ...item, source: { kind: 'installedSurface', surface: { pluginId: 'acme.widgets', localId: 'absent' } } },
      } })).resolves.toMatchObject({ errorCode: 'session_board_invalid' });
      expect(writes).toBe(1);
      // Retired shapes fail strict input admission before any Session transport.
      expect(sessionQueries).toEqual([{ accessProjectionVersion: '1' }]);
    } finally { rawSession.metadata = previousMetadata; }
  });
  it('updates a stored installed item while refusing a different surface identity', async () => {
    const writes: unknown[] = [];
    app.get('/v2/sessions/session-one/system-records/record', async () => ({ record: { id: 'item-row',
      address: { owner: 'host', namespace: 'surface', kind: 'item.v1', localId: 'status' }, content: { t: 'plain', v: installed }, revision,
      createdAt: '2026-09-05T00:00:00.000Z', updatedAt: '2026-09-05T00:00:00.000Z' } }));
    app.put('/v2/sessions/session-one/board', async (request) => {
      writes.push(request.body);
      return { operation: 'upsert_item', itemId: 'status', outcome: 'updated', itemRevision: revision };
    });
    const deps = createSessionBoardActionDeps({ credentials: { token: 'token', encryption: null }, serverId: 'home-a', serverHttpBaseUrl: 'http://board.test' });
    await expect(deps.sessionBoardAction!({ actionId: 'session.board.item.upsert', context: {}, input: {
      sessionId: 'session-one', itemId: 'status', expectedItemRevision: revision, item: { ...installed, title: 'Renamed' },
    } })).resolves.toMatchObject({ result: { outcome: 'updated' } });
    expect(writes).toEqual([expect.objectContaining({ itemContent: { t: 'plain', v: { ...installed, title: 'Renamed' } } })]);
    await expect(deps.sessionBoardAction!({ actionId: 'session.board.item.upsert', context: {}, input: {
      sessionId: 'session-one', itemId: 'status', expectedItemRevision: revision,
      item: { ...installed, source: { ...installed.source, instance: {
        ...installed.source.instance, definition: { ...installed.source.instance.definition, surface: { ...installed.source.instance.definition.surface, localId: 'other' } },
      } } },
    } })).resolves.toMatchObject({ errorCode: 'session_board_source_conflict' });
    expect(writes).toHaveLength(1);
  });
  it('refuses a different Home and read-only mutations before record access', async () => {
    const deps = createSessionBoardActionDeps({ credentials: { token: 'token', encryption: null }, serverId: 'home-a', serverHttpBaseUrl: 'http://board.test' });
    await expect(deps.sessionBoardAction!({ actionId: 'session.board.get', context: { serverId: 'home-b' }, input: { sessionId: 'session-one' } })).resolves.toMatchObject({ errorCode: 'server_target_mismatch' });
    const previous = rawSession.effectiveAccess;
    rawSession.effectiveAccess = { v: 1, level: 'view', sources: [{ kind: 'direct', shareId: 'share-one' }], capabilities: projectSessionAccessCapabilitiesV1({ owner: false, grants: [{ accessLevel: 'view', canApprovePermissions: false }] }) };
    try {
      await expect(deps.sessionBoardAction!({ actionId: 'session.board.item.upsert', context: {}, input: { sessionId: 'session-one', itemId: 'note', item,
        expectedItemRevision: null, placement: { tabId: 'overview', tabTitle: 'Overview' } } })).resolves.toMatchObject({ errorCode: 'session_board_forbidden' });
    } finally { rawSession.effectiveAccess = previous; }
  });
  it('returns operation-scoped feature-disabled and update-required results before Session access', async () => {
    let serverSnapshot: CliServerFeaturesSnapshot = {
      status: 'ready' as const,
      features: FeaturesResponseSchema.parse({
        features: { sessions: { enabled: true, board: { enabled: false } } },
        capabilities: {},
      }),
    };
    const deps = createSessionBoardActionDeps({
      credentials: { token: 'token', encryption: null },
      serverId: 'home-a',
      serverHttpBaseUrl: 'http://board.test',
      resolveServerFeaturesSnapshot: async () => serverSnapshot,
    });
    const args = { actionId: 'session.board.get' as const, context: {}, input: { sessionId: 'session-one' } };

    await expect(deps.sessionBoardAction!(args)).resolves.toMatchObject({
      ok: false,
      errorCode: 'feature_disabled',
      details: { operation: 'session.board.get', featureDecision: { featureId: 'sessions.board', state: 'disabled' } },
    });

    serverSnapshot = {
      status: 'unsupported' as const,
      reason: 'endpoint_missing' as const,
    };
    await expect(deps.sessionBoardAction!(args)).resolves.toEqual({
      ok: false,
      errorCode: 'update_required',
      error: 'update_required',
      details: {
        kind: 'update_required',
        operation: 'session.board.get',
        component: 'server',
        reason: 'sessions_board_endpoint_missing',
      },
    });
  });
  it('returns bounded inventory and exact requested bodies through the same host reader', async () => {
    const record = { id: 'item-row', address: { owner: 'host', namespace: 'surface', kind: 'item.v1', localId: 'note' }, content: { t: 'plain', v: item }, revision,
      createdAt: '2026-09-05T00:00:00.000Z', updatedAt: '2026-09-05T00:00:00.000Z' };
    app.get('/v2/sessions/session-one/system-records/record', async (request) => ({ record: (request.query as { kind?: string }).kind === 'layout.v1' ? null : record }));
    app.get('/v2/sessions/session-one/system-records', async () => ({ records: [record, record], nextCursor: 'page-two', hasNext: true }));
    const deps = createSessionBoardActionDeps({ credentials: { token: 'token', encryption: null }, serverId: 'home-a', serverHttpBaseUrl: 'http://board.test' });
    await expect(deps.sessionBoardAction!({ actionId: 'session.board.get', context: {}, input: { sessionId: 'session-one' } })).resolves.toMatchObject({
      layout: null, items: [{ itemId: 'note', title: 'Note', sourceKind: 'declarative', revision }], incomplete: true, page: { cursor: 'page-two', hasNext: true },
    });
    await expect(deps.sessionBoardAction!({ actionId: 'session.board.get', context: {}, input: { sessionId: 'session-one', itemIds: ['note', 'note'] } })).resolves.toMatchObject({
      items: [{ itemId: 'note', item }], incomplete: false,
    });
  });
  it.each(['session.board.layout.update', 'session.board.item.remove'] as const)('uses complete layout operands for %s without inventory replacement', async (actionId) => {
    const layout = { v: 1, tabs: ['a', 'b'].map((id) => ({ id, title: id, items: [{ itemId: 'note', width: 'medium' }] })) };
    const writes: unknown[] = [];
    app.get('/v2/sessions/session-one/system-records/record', async () => ({ record: { id: 'layout-row', address: { owner: 'host', namespace: 'surface', kind: 'layout.v1', localId: 'layout' },
      revision, content: { t: 'plain', v: layout }, createdAt: '2026-09-05T00:00:00.000Z', updatedAt: '2026-09-05T00:00:00.000Z' } }));
    app.put('/v2/sessions/session-one/board', async (request) => {
      writes.push(request.body);
      return actionId === 'session.board.item.remove' ? { operation: 'remove_item', itemId: 'note', outcome: 'removed', layoutRevision: revision }
        : { operation: 'update_layout', outcome: 'updated', layoutRevision: revision };
    });
    const deps = createSessionBoardActionDeps({ credentials: { token: 'token', encryption: null }, serverId: 'home-a', serverHttpBaseUrl: 'http://board.test' });
    await deps.sessionBoardAction!({ actionId, context: {}, input: actionId === 'session.board.item.remove'
      ? { sessionId: 'session-one', itemId: 'note', expectedItemRevision: revision, expectedLayoutRevision: revision }
      : { sessionId: 'session-one', expectedLayoutRevision: revision, operation: { op: 'item.resize', itemId: 'note', tabId: 'a', width: 'wide' } } });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ expectedLayoutRevision: revision, layoutContent: { t: 'plain', v: { tabs: actionId === 'session.board.item.remove'
      ? [{ id: 'a', items: [] }, { id: 'b', items: [] }]
      : [{ id: 'a', items: [{ itemId: 'note', width: 'wide' }] }, { id: 'b', items: [{ itemId: 'note', width: 'medium' }] }],
    } } });
  });
  it('acknowledges the requested second view when an item already placed elsewhere gains another placement', async () => {
    const layout = { v: 1, tabs: [
      { id: 'overview', title: 'Overview', items: [{ itemId: 'note', width: 'medium' }] },
      { id: 'second', title: 'Second', items: [] },
    ] };
    const writes: Array<{ placement?: { layoutContent: { v: unknown } } }> = [];
    app.get('/v2/sessions/session-one/system-records/record', async (request) => {
      const query = request.query as { kind?: string };
      return { record: query.kind === 'item.v1'
        ? { id: 'item-row', address: { owner: 'host', namespace: 'surface', kind: 'item.v1', localId: 'note' },
          revision, content: { t: 'plain', v: item }, createdAt: '2026-09-05T00:00:00.000Z', updatedAt: '2026-09-05T00:00:00.000Z' }
        : { id: 'layout-row', address: { owner: 'host', namespace: 'surface', kind: 'layout.v1', localId: 'layout' },
          revision, content: { t: 'plain', v: layout }, createdAt: '2026-09-05T00:00:00.000Z', updatedAt: '2026-09-05T00:00:00.000Z' } };
    });
    app.put('/v2/sessions/session-one/board', async (request) => {
      writes.push(request.body as never);
      return { operation: 'upsert_item', itemId: 'note', outcome: 'updated', itemRevision: revision, layoutRevision: revision };
    });
    const deps = createSessionBoardActionDeps({ credentials: { token: 'token', encryption: null }, serverId: 'home-a', serverHttpBaseUrl: 'http://board.test' });
    // Through the real Action executor: its strict result correspondence is the deciding consumer.
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), ...deps });
    const input = { sessionId: 'session-one', itemId: 'note', expectedItemRevision: revision, item,
      placement: { tabId: 'second', width: 'wide' as const } };
    const result = await executor.execute('session.board.item.upsert', input, {
      surface: 'cli', authority: 'present_user', serverId: 'home-a', defaultSessionId: 'session-one', bypassApprovals: true,
    });
    expect(result).toMatchObject({ ok: true, result: { destination: { tabId: 'second', width: 'wide' } } });
    expect(writes[0]?.placement?.layoutContent.v).toMatchObject({ tabs: [
      { id: 'overview', items: [{ itemId: 'note', width: 'medium' }] },
      { id: 'second', items: [{ itemId: 'note', width: 'wide' }] },
    ] });
  });
  it('carries the exact current item participant for item.place and refuses a missing item before dispatch', async () => {
    const layout = { v: 1, tabs: [{ id: 'overview', title: 'Overview', items: [] }] };
    const writes: unknown[] = [];
    let itemExists = true;
    app.get('/v2/sessions/session-one/system-records/record', async (request) => {
      const query = request.query as { kind?: string };
      return { record: query.kind === 'item.v1'
        ? itemExists ? { id: 'item-row', address: { owner: 'host', namespace: 'surface', kind: 'item.v1', localId: 'note' },
          revision, content: { t: 'plain', v: item }, createdAt: '2026-09-05T00:00:00.000Z', updatedAt: '2026-09-05T00:00:00.000Z' } : null
        : { id: 'layout-row', address: { owner: 'host', namespace: 'surface', kind: 'layout.v1', localId: 'layout' },
          revision, content: { t: 'plain', v: layout }, createdAt: '2026-09-05T00:00:00.000Z', updatedAt: '2026-09-05T00:00:00.000Z' } };
    });
    app.put('/v2/sessions/session-one/board', async (request) => {
      writes.push(request.body);
      return { operation: 'update_layout', outcome: 'updated', layoutRevision: revision };
    });
    const deps = createSessionBoardActionDeps({ credentials: { token: 'token', encryption: null }, serverId: 'home-a', serverHttpBaseUrl: 'http://board.test' });
    const input = { sessionId: 'session-one', expectedLayoutRevision: revision,
      operation: { op: 'item.place' as const, itemId: 'note', tabId: 'overview', width: 'wide' as const } };
    await expect(deps.sessionBoardAction!({ actionId: 'session.board.layout.update', context: {}, input })).resolves.toMatchObject({
      v: 1,
      serverId: 'home-a',
      sessionId: 'session-one',
      result: { operation: 'update_layout' },
    });
    expect(writes).toEqual([expect.objectContaining({
      operation: 'update_layout',
      itemPlacementParticipant: { itemId: 'note', expectedItemRevision: revision },
    })]);

    itemExists = false;
    writes.length = 0;
    await expect(deps.sessionBoardAction!({ actionId: 'session.board.layout.update', context: {}, input })).resolves.toEqual({
      ok: false, errorCode: 'session_board_item_not_found', error: 'session_board_item_not_found',
    });
    expect(writes).toHaveLength(0);
  });
  it('does not replay an ambiguous E2EE mutation whose acknowledgement is lost', async () => {
    rawSession.encryptionMode = 'e2ee';
    const secret = new Uint8Array(32).fill(7);
    app.get('/v2/sessions/session-one/system-records/record', async () => ({ record: null }));
    const request = axios.request.bind(axios);
    const bodies: unknown[] = [];
    vi.spyOn(axios, 'request').mockImplementation(async (config) => {
      if (config.method?.toUpperCase() === 'PUT') {
        bodies.push(config.data);
        throw new axios.AxiosError('acknowledgement lost', 'ECONNRESET');
      }
      return request(config);
    });
    const deps = createSessionBoardActionDeps({ credentials: { token: 'token', encryption: { type: 'legacy', secret } }, serverId: 'home-a', serverHttpBaseUrl: 'http://board.test' });
    await expect(deps.sessionBoardAction!({ actionId: 'session.board.item.upsert', context: { defaultSessionId: 'session-one' }, input: {
      itemId: 'note', item, expectedItemRevision: null, placement: { tabId: 'overview', tabTitle: 'Overview' },
    } })).resolves.toMatchObject({ ok: false, errorCode: 'outcome_unknown' });
    expect(bodies).toHaveLength(1);
    const sealed = JSON.parse(String(bodies[0]));
    expect(sealed.itemContent.t).toBe('encrypted');
    expect(decrypt(secret, 'legacy', decodeBase64(sealed.itemContent.c, 'base64'))).toEqual(item);
    expect(decrypt(secret, 'legacy', decodeBase64(sealed.placement.layoutContent.c, 'base64'))).toMatchObject({ tabs: [{ items: [{ itemId: 'note' }] }] });
  });
  it('keeps DNS failure definite and does not replay the mutation', async () => {
    app.get('/v2/sessions/session-one/system-records/record', async () => ({ record: null }));
    const request = axios.request.bind(axios);
    let writes = 0;
    vi.spyOn(axios, 'request').mockImplementation(async (config) => {
      if (config.method?.toUpperCase() === 'PUT') {
        writes += 1;
        throw new axios.AxiosError('DNS lookup failed', 'ENOTFOUND');
      }
      return request(config);
    });
    const deps = createSessionBoardActionDeps({ credentials: { token: 'token', encryption: null }, serverId: 'home-a', serverHttpBaseUrl: 'http://board.test' });
    await expect(deps.sessionBoardAction!({ actionId: 'session.board.layout.update', context: {}, input: {
      sessionId: 'session-one', expectedLayoutRevision: null, operation: { op: 'tab.create', tabId: 'overview', title: 'Overview' },
    } })).resolves.toEqual({ ok: false, errorCode: 'offline', error: 'offline' });
    expect(writes).toBe(1);
  });
  it('keeps a wrapped connection refusal definite on both carriers', async () => {
    app.get('/v2/sessions/session-one/system-records/record', async () => ({ record: null }));
    const request = axios.request.bind(axios);
    let writes = 0;
    vi.spyOn(axios, 'request').mockImplementation(async (config) => {
      if (config.method?.toUpperCase() === 'PUT') {
        writes += 1;
        // An interceptor-wrapped refusal: the code the UI carrier already walks to through `cause`.
        const wrapped = new axios.AxiosError('request failed', undefined, undefined, {});
        wrapped.cause = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
        throw wrapped;
      }
      return request(config);
    });
    const deps = createSessionBoardActionDeps({ credentials: { token: 'token', encryption: null }, serverId: 'home-a', serverHttpBaseUrl: 'http://board.test' });
    await expect(deps.sessionBoardAction!({ actionId: 'session.board.layout.update', context: {}, input: {
      sessionId: 'session-one', expectedLayoutRevision: null, operation: { op: 'tab.create', tabId: 'overview', title: 'Overview' },
    } })).resolves.toEqual({ ok: false, errorCode: 'offline', error: 'offline' });
    expect(writes).toBe(1);
  });
  it('preserves the original intent when a valid acknowledgement belongs to another item', async () => {
    app.get('/v2/sessions/session-one/system-records/record', async () => ({ record: null }));
    app.put('/v2/sessions/session-one/board', async () => ({ operation: 'upsert_item', itemId: 'other', outcome: 'created', itemRevision: revision, layoutRevision: revision }));
    const deps = createSessionBoardActionDeps({ credentials: { token: 'token', encryption: null }, serverId: 'home-a', serverHttpBaseUrl: 'http://board.test' });
    const input = { itemId: 'note', item, expectedItemRevision: null, placement: { tabId: 'overview', tabTitle: 'Overview' } };
    await expect(deps.sessionBoardAction!({ actionId: 'session.board.item.upsert', context: { defaultSessionId: 'session-one' }, input })).resolves.toMatchObject({
      ok: false, errorCode: 'outcome_unknown', details: { recovery: { requestBody: expect.any(String), intent: input } },
    });
  });
  it('keeps exact sealed recovery evidence through the real Action executor without replaying an ambiguous mutation', async () => {
    app.get('/v2/sessions/session-one/system-records/record', async () => ({ record: null }));
    app.put('/v2/sessions/session-one/board', async (_request, reply) => reply.hijack());
    const request = axios.request.bind(axios);
    const writes: string[] = [];
    vi.spyOn(axios, 'request').mockImplementation(async (config) => {
      if (config.method?.toUpperCase() === 'PUT') {
        writes.push(String(config.data));
        throw new axios.AxiosError('acknowledgement lost', 'ECONNRESET');
      }
      return request(config);
    });
    const deps = createSessionBoardActionDeps({ credentials: { token: 'token', encryption: null }, serverId: 'home-a', serverHttpBaseUrl: 'http://board.test' });
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), ...deps });
    const input = {
      sessionId: 'session-one',
      itemId: 'note',
      item,
      expectedItemRevision: null,
      placement: { tabId: 'overview', tabTitle: 'Overview' },
    } as const;

    const result = await executor.execute('session.board.item.upsert', input, {
      surface: 'cli',
      authority: 'present_user',
      serverId: 'home-a',
      defaultSessionId: 'session-one',
      bypassApprovals: true,
    });
    // An ambiguous post-dispatch loss is reported, never re-dispatched: the same
    // sealed bytes stay available as recovery evidence for a deliberate reread.
    expect(writes).toHaveLength(1);
    expect(result).toEqual({
      ok: false,
      errorCode: 'outcome_unknown',
      error: 'outcome_unknown',
      details: {
        recovery: {
          v: 1,
          actionId: 'session.board.item.upsert',
          serverId: 'home-a',
          sessionId: 'session-one',
          requestBody: writes[0],
          mutationRequest: JSON.parse(writes[0]!),
          intent: { ...input, destination: 'board' },
        },
      },
    });
  });
  it('preserves typed non-2xx failures and classifies malformed 2xx as outcome unknown', async () => {
    app.get('/v2/sessions/session-one/system-records/record', async () => ({ record: null }));
    let responseKind: 'conflict' | 'malformed_success' | 'malformed_failure' | 'feature_disabled' | 'transport_failure' = 'conflict';
    let transportFailure: Readonly<{ status: number; body: unknown }> = { status: 401, body: {} };
    app.put('/v2/sessions/session-one/board', async (_request, reply) => {
      if (responseKind === 'transport_failure') return reply.code(transportFailure.status).send(transportFailure.body);
      if (responseKind === 'feature_disabled') return reply.code(404).send({ error: 'not_found' });
      if (responseKind === 'malformed_success') return reply.code(200).send({ definitely: 'not-a-board-result' });
      if (responseKind === 'malformed_failure') return reply.code(500).send({ definitely: 'not-a-board-error' });
      return reply.code(409).send({ error: 'session_board_revision_conflict', currentLayoutRevision: revision });
    });
    const deps = createSessionBoardActionDeps({ credentials: { token: 'token', encryption: null }, serverId: 'home-a', serverHttpBaseUrl: 'http://board.test' });
    const args = {
      actionId: 'session.board.layout.update' as const,
      context: {},
      input: { sessionId: 'session-one', expectedLayoutRevision: null, operation: { op: 'tab.create' as const, tabId: 'overview', title: 'Overview' } },
    };

    await expect(deps.sessionBoardAction!(args)).resolves.toEqual({
      ok: false,
      errorCode: 'session_board_revision_conflict',
      error: 'session_board_revision_conflict',
      details: { currentLayoutRevision: revision },
    });
    responseKind = 'malformed_success';
    const malformedSuccess = await deps.sessionBoardAction!(args);
    expect(malformedSuccess).toMatchObject({
      ok: false,
      errorCode: 'outcome_unknown',
      details: {
        recovery: {
          v: 1,
          actionId: 'session.board.layout.update',
          serverId: 'home-a',
          sessionId: 'session-one',
          requestBody: expect.any(String),
          mutationRequest: expect.objectContaining({ operation: 'update_layout' }),
          intent: args.input,
        },
      },
    });
    responseKind = 'malformed_failure';
    await expect(deps.sessionBoardAction!(args)).resolves.toEqual({
      ok: false,
      errorCode: 'server_error',
      error: 'server_error',
    });
    responseKind = 'feature_disabled';
    await expect(deps.sessionBoardAction!(args)).resolves.toEqual({
      ok: false,
      errorCode: 'feature_disabled',
      error: 'feature_disabled',
      details: { operation: 'session.board.layout.update' },
    });
    responseKind = 'transport_failure';
    for (const [status, body, errorCode] of [
      [401, { error: 'private authentication diagnostics' }, 'not_authenticated'],
      [403, { error: 'private authorization diagnostics' }, 'forbidden'],
      [404, { error: 'Not found', code: 'plugin_session_not_found' }, 'not_found'],
      [503, { error: 'Unavailable', code: 'plugin_session_records_unavailable' }, 'protocol_unavailable'],
      [400, { error: 'Invalid request', code: 'plugin_session_record_invalid_request' }, 'malformed'],
    ] as const) {
      transportFailure = { status, body };
      await expect(deps.sessionBoardAction!(args)).resolves.toEqual({ ok: false, errorCode, error: errorCode });
    }
  });
  it('preserves the current revision when the local Board read detects a conflict', async () => {
    let writes = 0;
    app.get('/v2/sessions/session-one/system-records/record', async () => ({ record: {
      id: 'layout-row', address: { owner: 'host', namespace: 'surface', kind: 'layout.v1', localId: 'layout' },
      content: { t: 'plain', v: { v: 1, tabs: [] } }, revision,
      createdAt: '2026-09-05T00:00:00.000Z', updatedAt: '2026-09-05T00:00:00.000Z',
    } }));
    app.put('/v2/sessions/session-one/board', async () => {
      writes += 1;
      return { operation: 'update_layout', outcome: 'updated', layoutRevision: revision };
    });
    const deps = createSessionBoardActionDeps({ credentials: { token: 'token', encryption: null }, serverId: 'home-a', serverHttpBaseUrl: 'http://board.test' });

    await expect(deps.sessionBoardAction!({
      actionId: 'session.board.layout.update',
      context: {},
      input: { sessionId: 'session-one', expectedLayoutRevision: null, operation: { op: 'tab.create', tabId: 'overview', title: 'Overview' } },
    })).resolves.toEqual({
      ok: false,
      errorCode: 'session_board_revision_conflict',
      error: 'session_board_revision_conflict',
      details: { currentLayoutRevision: revision },
    });
    expect(writes).toBe(0);
  });
  it('returns cancelled before dispatch when its signal is already aborted', async () => {
    app.get('/v2/sessions/session-one/system-records/record', async () => ({ record: null }));
    let writes = 0;
    app.put('/v2/sessions/session-one/board', async () => {
      writes += 1;
      return { operation: 'update_layout', outcome: 'created', layoutRevision: revision };
    });
    const controller = new AbortController();
    controller.abort();
    const deps = createSessionBoardActionDeps({ credentials: { token: 'token', encryption: null }, serverId: 'home-a', serverHttpBaseUrl: 'http://board.test' });

    await expect(deps.sessionBoardAction!({
      actionId: 'session.board.layout.update',
      context: {},
      input: { sessionId: 'session-one', expectedLayoutRevision: null, operation: { op: 'tab.create', tabId: 'overview', title: 'Overview' } },
      signal: controller.signal,
    })).resolves.toEqual({ ok: false, errorCode: 'cancelled', error: 'cancelled' });
    expect(writes).toBe(0);
  });
  it('creates one atomic first placement through host V1 reads with keyless Plain credentials', async () => {
    const requests: unknown[] = [];
    app.get('/v2/sessions/session-one/system-records/record', async (request) => {
      expect(request.headers).not.toHaveProperty('x-happier-plugin-id');
      expect(request.query).toMatchObject({ owner: 'host', namespace: 'surface' });
      return { record: null };
    });
    app.put('/v2/sessions/session-one/board', async (request) => {
      requests.push(request.body);
      return { operation: 'upsert_item', itemId: 'note', outcome: 'created', itemRevision: revision, layoutRevision: revision };
    });
    const deps = createSessionBoardActionDeps({ credentials: { token: 'token', encryption: null }, serverId: 'home-a', serverHttpBaseUrl: 'http://board.test' });
    await expect(deps.sessionBoardAction!({ actionId: 'session.board.item.upsert', context: { defaultSessionId: 'session-one' }, input: {
      itemId: 'note', item, expectedItemRevision: null, placement: { tabId: 'overview', tabTitle: 'Overview' },
    } })).resolves.toMatchObject({ serverId: 'home-a', sessionId: 'session-one', result: { outcome: 'created' } });
    expect(requests).toEqual([{ operation: 'upsert_item', itemId: 'note', expectedItemRevision: null, destination: 'board', itemContent: { t: 'plain', v: item },
      placement: { expectedLayoutRevision: null, layoutContent: { t: 'plain', v: { v: 1, tabs: [{ id: 'overview', title: 'Overview', items: [{ itemId: 'note', width: 'medium' }] }] } } },
    }]);
  });

  it('lets one admitted Agent author and organize a Board, then reveal its exact surviving item through the current UI owner', async () => {
    type StoredRecordFixture = Readonly<{
      id: string;
      address: Readonly<{ owner: 'host'; namespace: 'surface'; kind: 'item.v1' | 'layout.v1'; localId: string }>;
      content: unknown;
      revision: string;
      createdAt: string;
      updatedAt: string;
    }>;
    const timestamp = '2026-09-08T00:00:00.000Z';
    const makeRecord = (
      kind: StoredRecordFixture['address']['kind'],
      localId: string,
      content: unknown,
    ): StoredRecordFixture => ({
      id: `${kind}:${localId}`,
      address: { owner: 'host', namespace: 'surface', kind, localId },
      content,
      revision,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    let layoutRecord: StoredRecordFixture | null = null;
    const itemRecords = new Map<string, StoredRecordFixture>();
    const mutations: unknown[] = [];

    app.get('/v2/sessions/session-one/system-records/record', async (request) => {
      const query = request.query as Readonly<{ kind: 'item.v1' | 'layout.v1'; localId: string }>;
      return { record: query.kind === 'layout.v1' ? layoutRecord : itemRecords.get(query.localId) ?? null };
    });
    app.get('/v2/sessions/session-one/system-records', async () => ({
      records: [...itemRecords.values()],
      nextCursor: null,
      hasNext: false,
    }));
    app.put('/v2/sessions/session-one/board', async (request) => {
      const mutation = request.body as Readonly<{
        operation: 'upsert_item' | 'remove_item' | 'update_layout';
        itemId?: string;
        itemContent?: unknown;
        layoutContent?: unknown;
        placement?: Readonly<{ layoutContent: unknown }>;
      }>;
      mutations.push(mutation);
      if (mutation.operation === 'upsert_item' && mutation.itemId && mutation.itemContent) {
        const outcome = itemRecords.has(mutation.itemId) ? 'updated' : 'created';
        itemRecords.set(mutation.itemId, makeRecord('item.v1', mutation.itemId, mutation.itemContent));
        if (mutation.placement) layoutRecord = makeRecord('layout.v1', 'layout', mutation.placement.layoutContent);
        return { operation: 'upsert_item', itemId: mutation.itemId, outcome, itemRevision: revision, ...(mutation.placement ? { layoutRevision: revision } : {}) };
      }
      if (mutation.operation === 'remove_item' && mutation.itemId && mutation.layoutContent) {
        itemRecords.delete(mutation.itemId);
        layoutRecord = makeRecord('layout.v1', 'layout', mutation.layoutContent);
        return { operation: 'remove_item', itemId: mutation.itemId, outcome: 'removed', layoutRevision: revision };
      }
      if (mutation.operation === 'update_layout' && mutation.layoutContent) {
        layoutRecord = makeRecord('layout.v1', 'layout', mutation.layoutContent);
        return { operation: 'update_layout', outcome: 'updated', layoutRevision: revision };
      }
      throw new Error('Unexpected Board mutation fixture');
    });

    const boardDeps = createSessionBoardActionDeps({
      credentials: { token: 'runtime-account-token', encryption: null },
      serverId: 'home-a',
      serverHttpBaseUrl: 'http://board.test',
    });
    const admittedContexts: unknown[] = [];
    const sessionBoardAction: NonNullable<ActionExecutorDeps['sessionBoardAction']> = async (args) => {
      admittedContexts.push(args.context);
      return await boardDeps.sessionBoardAction!(args);
    };
    const executor = createActionExecutor({
      ...createUnavailableActionTransportDeps(),
      ...boardDeps,
      sessionBoardAction,
    });
    // Production Action executors are fixed to the selected Home by
    // `createCliActionExecutorHarness`; preserve that host-stamped context in
    // this lower-level composition fixture as well.
    const agentTools = createActionToolExecutorBridge({
      surface: 'agent',
      executor: {
        execute: (actionId, input, context) => {
          expect(context.defaultSessionId).toBe('session-one');
          return executor.execute(actionId, input, {
            ...context,
            serverId: 'home-a',
            actionCaller: { kind: 'session', sessionId: 'session-one', starterDepth: 0, turnDepth: 0 },
            // Removal is already confirmed here; authoring and organization
            // exercise the own-Session per-Action defaults without a waiver.
            ...(actionId === 'session.board.item.remove'
              ? { bypassApprovals: true } : {}),
          });
        },
      },
    });
    const executeBoardAction = async (actionId: string, input: unknown) => await agentTools.executeActionByToolName(
      'action_execute',
      { actionId, input },
      'session-one',
    );
    const note = (title: string, text: string) => ({
      ...item,
      title,
      source: { kind: 'declarative' as const, document: { version: 1 as const, root: { kind: 'markdown' as const, text } } },
    });

    const mutationCountBeforeSpoof = mutations.length;
    await expect(executeBoardAction('session.board.item.upsert', {
      itemId: 'release-checklist',
      expectedItemRevision: null,
      item: note('Release checklist', 'Draft'),
      placement: { tabId: 'overview', tabTitle: 'Overview', width: 'wide' },
      requestedBy: 'bob-account',
    })).resolves.toMatchObject({ ok: false });
    expect(mutations).toHaveLength(mutationCountBeforeSpoof);

    const ownSessionCreate = await executeBoardAction('session.board.item.upsert', {
      itemId: 'release-checklist', expectedItemRevision: null,
      item: note('Release checklist', 'Draft'),
      placement: { tabId: 'overview', tabTitle: 'Overview', width: 'wide' },
    });
    expect(ownSessionCreate, JSON.stringify(ownSessionCreate)).toMatchObject({ ok: true });
    await expect(executeBoardAction('session.board.item.upsert', {
      itemId: 'temporary-note', expectedItemRevision: null,
      item: note('Temporary note', 'Remove me'),
      placement: { tabId: 'overview' },
    })).resolves.toMatchObject({ ok: true });
    await expect(executeBoardAction('session.board.item.upsert', {
      itemId: 'release-checklist', expectedItemRevision: revision,
      item: note('Release checklist', 'Final'),
    })).resolves.toMatchObject({ ok: true });
    await expect(executeBoardAction('session.board.layout.update', {
      expectedLayoutRevision: revision,
      operation: { op: 'tab.create', tabId: 'details', title: 'Details' },
    })).resolves.toMatchObject({ ok: true });
    await expect(executeBoardAction('session.board.layout.update', {
      expectedLayoutRevision: revision,
      operation: { op: 'item.move', itemId: 'release-checklist', fromTabId: 'overview', toTabId: 'details' },
    })).resolves.toMatchObject({ ok: true });
    await expect(executeBoardAction('session.board.layout.update', {
      expectedLayoutRevision: revision,
      operation: { op: 'tab.move', tabId: 'details', anchor: { side: 'before', tabId: 'overview' } },
    })).resolves.toMatchObject({ ok: true });
    await expect(executeBoardAction('session.board.item.remove', {
      itemId: 'temporary-note', expectedItemRevision: revision, expectedLayoutRevision: revision,
    })).resolves.toMatchObject({ ok: true });

    const board = await executeBoardAction('session.board.get', { itemIds: ['release-checklist', 'temporary-note'] });
    expect(board).toMatchObject({
      ok: true,
      result: {
        layout: { document: { tabs: [
          { id: 'details', items: [{ itemId: 'release-checklist', width: 'wide' }] },
          { id: 'overview', items: [] },
        ] } },
        items: [{ itemId: 'release-checklist', item: { title: 'Release checklist' } }],
        incomplete: true,
      },
    });
    expect(admittedContexts).toEqual(admittedContexts.map((context) => expect.objectContaining({
      surface: 'agent',
      authority: 'account_automation',
    })));

    let agentState: AgentState = {};
    const rpcHandlers = new Map<string, RpcHandler>();
    const presentationContext = {
      signal: new AbortController().signal,
      authorization: {
        kind: SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.CURRENT_SESSION_PRESENTATION_ORIGIN,
        sessionId: 'session-one',
        accountId: 'owner-account',
        connectionId: 'owner-ui-connection',
      },
    } as const;
    let boundHostNonce = '';
    const appliedIntents: unknown[] = [];
    const presentationSession = {
      sessionId: 'session-one',
      rpcHandlerManager: {
        registerHandler: (method: string, handler: RpcHandler) => { rpcHandlers.set(method, handler); },
        invokeLocal: async (method: string, params: unknown) => {
          const handler = rpcHandlers.get(method);
          if (!handler) throw new Error(`Missing local RPC handler: ${method}`);
          return await handler(params);
        },
      },
      updateAgentState: async (updater: (state: AgentState) => AgentState) => {
        agentState = updater(agentState);
        const state = CurrentSessionPresentationStateV1Schema.parse(
          (agentState as Record<string, unknown>)[CURRENT_SESSION_PRESENTATION_AGENT_STATE_KEY],
        );
        const command = state.command;
        if (command?.kind !== 'presentation.apply') return;
        const intent = command.intent;
        appliedIntents.push(intent);
        const openedLayout = layoutRecord?.content as Readonly<{ t: 'plain'; v: { tabs: readonly { id: string; items: readonly { itemId: string }[] }[] } }> | undefined;
        const targetExists = intent.kind !== 'board.item.reveal' || (
          itemRecords.has(intent.widgetId)
          && openedLayout?.v.tabs.some((tab) => tab.items.some((placement) => placement.itemId === intent.widgetId)) === true
        );
        queueMicrotask(() => {
          void rpcHandlers.get(CURRENT_SESSION_PRESENTATION_ACK_RPC_METHOD)?.({
            hostNonce: boundHostNonce,
            clientId: command.clientId,
            commandId: command.id,
            result: { status: targetExists ? 'applied' : 'invalidTarget' },
          }, presentationContext);
        });
      },
    } satisfies Pick<SessionClientPort, 'sessionId' | 'rpcHandlerManager' | 'updateAgentState'>;
    const presentationAbort = new AbortController();
    const presentation = createCurrentSessionPresentationService({
      session: presentationSession,
      signal: presentationAbort.signal,
      isCurrent: () => true,
      ackTimeoutMs: 100,
    });
    const bound = await rpcHandlers.get(CURRENT_SESSION_PRESENTATION_BIND_RPC_METHOD)?.({
      clientId: 'focused-ui', focused: true, draftRevision: 0,
    }, presentationContext) as Readonly<{ hostNonce: string }>;
    boundHostNonce = bound.hostNonce;

    await expect(presentation.present({
      operationId: 'agent-open-board',
      intent: { kind: 'board.open', mode: 'focus' },
    })).resolves.toMatchObject({ status: 'applied' });
    await expect(presentation.present({
      operationId: 'agent-reveal-release-checklist',
      intent: { kind: 'board.item.reveal', widgetId: 'release-checklist', viewId: 'details' },
    })).resolves.toMatchObject({ status: 'applied' });
    expect(appliedIntents).toEqual([
      { kind: 'board.open', mode: 'focus' },
      { kind: 'board.item.reveal', widgetId: 'release-checklist', viewId: 'details' },
    ]);
    presentationAbort.abort();
  });
});
