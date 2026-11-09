import fastify from 'fastify';
import { z } from 'zod/mini';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildApprovalExecutionOriginV1, createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { TargetActionApprovalRequestV1Schema } from '@happier-dev/protocol/approvals/targetActionApprovalRequestV1';
import { FeaturesResponseSchema, decodePlainArtifactStoredContent } from '@happier-dev/protocol';
import { approvalArtifactBodyMatchesHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { executeContributedAction } from '@/plugins/runtime/invocation/actions/executeContributedAction';
import { createCommittedContributedActionDefinitionLister, createCommittedContributedActionSchemaReader } from '@/plugins/runtime/invocation/actions/createCommittedContributedActionDeps';
import { tryAcquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import { createPluginActionExecutor } from '@/session/actions/createDaemonPluginActionExecutor';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createTargetActionCurrentIntentAdapter } from '@/session/actions/approvals/targetActionCurrentIntent';
import { projectExecutablePluginToolCatalog } from '@/plugins/runtime/toolCatalog';
import { createActionToolExecutorBridge } from '@/agent/tools/happierTools/createActionToolExecutorBridge';
import { createHappierToolInventory } from '@/agent/tools/happierTools/listBuiltInHappierTools';
import { prepareHappierMcpToolInventory, registerHappierMcpBuiltInTools } from './registerHappierMcpBuiltInTools';
import { createCliApprovalsArtifactStore } from '@/session/actions/approvals/artifactStore';
import { artifactReadResponse } from '@/testkit/http/artifactHome';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { configuration } from '@/configuration';
import { resolveApprovalReplayRoute } from '../../../../ui/sources/sync/ops/actions/approvalReplayRoute';
import { buildApprovalHref } from '../../../../ui/sources/components/approvals/approvalNavigation';
import { getServerProfileById, removeServerProfile, setServerProfileIdentityForUrl, upsertServerProfile } from '../../../../ui/sources/sync/domains/server/serverProfiles';

describe('pending approval through real MCP and the shared native/plugin Action bridge', () => {
  const pluginId = 'acme.pending';
  const surfaces = ['agent', 'mcp', 'cli'] as const;
  let fixture: Awaited<ReturnType<typeof createAuthoredAdmittedPluginRuntimeFixture>> | null = null;
  let executor: ReturnType<typeof createPluginActionExecutor> | null = null;
  let pluginToolCatalog: ReturnType<typeof projectExecutablePluginToolCatalog> = [];
  const home = fastify();
  const serverIdentityId = 'srv_pending_home';
  const artifacts = new Map<string, { id: string; header: string; body: string; dataEncryptionKey: string;
    ownerAccountId: string; access: 'owner'; encryptionMode: 'plain'; headerVersion: number; bodyVersion: number;
    seq: number; createdAt: number; updatedAt: number }>();
  let store: ReturnType<typeof createCliApprovalsArtifactStore>;
  let serverHttpBaseUrl: string;
  let savedHomeId: string;
  let requestCurrentIntent: ReturnType<typeof createTargetActionCurrentIntentAdapter>;
  let originReads = 0;
  let created = 0;
  const unavailableReasons: string[] = [];
  beforeAll(async () => {
    const features = FeaturesResponseSchema.parse({ features: {}, capabilities: { serverIdentity: { serverIdentityId } } });
    home.get('/v1/features', async () => features);
    home.get('/v1/features/authenticated', async () => features);
    home.get('/v1/account/encryption', async () => ({ mode: 'plain', updatedAt: 1 }));
    home.get('/v1/account/encryption/currentness', async () => ({ mode: 'plain', updatedAt: 1,
      version: 1, settingsVersion: 1, signingKeyFingerprint: null, contentKeyFingerprint: null,
      recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' } }));
    home.get('/v1/account/profile', async () => ({ id: 'pending-account' }));
    home.get<{ Params: { id: string } }>('/v1/artifacts/:id', async (request, reply) => {
      const artifact = artifacts.get(request.params.id);
      return artifact ? { publicAudience: 'none', ...artifact } : reply.code(404).send({ error: 'artifact_not_found' });
    });
    home.post('/v1/artifacts/read', async request => artifactReadResponse(request.body, id => artifacts.get(id) ?? null).data);
    home.post<{ Body: { id: string; header: string; body: string; dataEncryptionKey: string } }>('/v1/artifacts', async request => {
      const artifact = { ...request.body, ownerAccountId: 'pending-account', access: 'owner' as const,
        encryptionMode: 'plain' as const, headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
      artifacts.set(artifact.id, artifact);
      return artifact;
    });
    await home.listen({ host: '127.0.0.1', port: 0 });
    const address = home.server.address();
    if (!address || typeof address === 'string') throw new Error('Expected fixture Home address');
    serverHttpBaseUrl = `http://127.0.0.1:${address.port}`;
    const credentials = { token: `fixture.${Buffer.from(JSON.stringify({ sub: 'pending-account' })).toString('base64url')}.signature`, encryption: null };
    store = createCliApprovalsArtifactStore({ credentials, serverId: configuration.activeServerId, serverHttpBaseUrl });
    await upsertServerProfile({ serverUrl: serverHttpBaseUrl, source: 'manual' });
    const savedHome = await setServerProfileIdentityForUrl(serverHttpBaseUrl, serverIdentityId);
    if (!savedHome) throw new Error('Expected saved fixture Home identity');
    savedHomeId = savedHome.id;
    const inputSchema = { type: 'object', properties: { label: { type: 'string' } }, required: ['label'], additionalProperties: false };
    const admitted = await createAuthoredAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
      // Home/Machine identity is an external environment boundary. The runtime
      // still derives and validates replay placement from its admitted occurrence.
      runtimeOptions: { resolveCurrentMachineExecutionOriginContext: async () => {
        originReads++;
        return { serverIdentityId, machineId: 'pending-machine' };
      } },
      plugins: [{
        manifest: createPluginManifestV2Fixture({ id: pluginId, contributes: {
          actions: [{ id: 'publish', title: 'Publish label', scopes: ['global'], surfaces: ['agent', 'mcp', 'cli'],
            execution: { target: 'daemon' }, dangerLevel: 'writesRemote', confirmation: { title: 'Publish label' }, inputSchema,
            resultSchema: inputSchema, tool: { name: 'qa_pending_publish' },
            toolExposure: { agent: 'direct', mcp: 'direct', cli: 'direct' } },
          { id: 'other', title: 'Other binding', scopes: ['global'], surfaces: ['mcp'],
            execution: { target: 'daemon' }, dangerLevel: 'safe', inputSchema,
            tool: { name: 'qa_pending_other' }, toolExposure: { mcp: 'direct' } }],
        } }),
        files: { 'daemon.mjs': 'export function activate(api) { api.actions.register("publish", async () => { throw new Error("Unapproved handler must not run"); }); api.actions.register("other", async input => input); }' },
      }] });
    fixture = admitted;
    const runtime = admitted.registry;
    await runtime.activateContributionsOnDemand([{ pluginId, family: 'actions', localId: 'publish' }]);
    // The Home HTTP routes are the persistence boundary. The real Artifact
    // writer produces both header and body from the actual admitted subject.
    requestCurrentIntent = createTargetActionCurrentIntentAdapter({
      create: async request => {
        const result = await runWithServerHttpBaseUrl(serverHttpBaseUrl, () => store.targetActionApprovalsCreate({ request }))
          .catch(error => {
            unavailableReasons.push(error instanceof Error ? error.name : 'non_error');
            if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') unavailableReasons.push(error.code);
            if (error && typeof error === 'object' && 'details' in error) unavailableReasons.push(JSON.stringify(error.details));
            throw error;
          });
        created++;
        return result;
      },
      read: async artifactId => runWithServerHttpBaseUrl(serverHttpBaseUrl, () => store.targetActionApprovalsGet({ artifactId })),
    });
    // Match the retained-runtime MCP host: the plugin adapter admits dynamic
    // qualified ids before the built-in executor, and owns their result mapping.
    const discoveryScope = {
      tryAcquireRuntimeRegistryLease: () => tryAcquireAuthoritativePluginRuntimeRegistryLease({
        controller: admitted.controller, happyHomeDir: admitted.happyHomeDir,
      }),
    };
    const listContributedActionDefinitions = createCommittedContributedActionDefinitionLister(discoveryScope);
    executor = createPluginActionExecutor({
      base: createActionExecutor({
        listContributedActionDefinitions,
        readContributedActionSchemas: createCommittedContributedActionSchemaReader(listContributedActionDefinitions),
      }),
      requestPluginActionExecution: async (request, options) => executeContributedAction({
        runtimeRegistry: runtime, actionId: request.actionId, input: request.input,
        requestCurrentIntent: request => requestCurrentIntent({ ...request,
          reportUnavailable: reason => unavailableReasons.push(reason) }),
        context: { surface: request.surface,
          ...(request.defaultSessionId ? { defaultSessionId: request.defaultSessionId } : {}),
          ...(options?.signal ? { signal: options.signal } : {}),
        },
      }),
    });
    pluginToolCatalog = projectExecutablePluginToolCatalog(runtime);
  });
  afterAll(async () => {
    await fixture?.dispose();
    const profile = getServerProfileById(serverIdentityId);
    if (profile) await removeServerProfile(profile.id);
    await home.close();
  });

  it.each(surfaces)('keeps the exact %s binding executable and its pending approval typed', async surface => {
      if (!fixture || !executor) throw new Error('Expected admitted plugin runtime');
      const runtime = fixture.registry;
      unavailableReasons.length = 0;
      const before = created;
      const originReadsBefore = originReads;
      const server = new McpServer({ name: 'pending-approval-test', version: '1.0.0' });
      const client = new Client({ name: 'pending-agent', version: '1.0.0' });
      try {
        const toolName = 'qa_pending_publish';
        const bridge = createActionToolExecutorBridge({ surface, executor, registry: runtime.contributes, pluginToolCatalog });
        const inventory = createHappierToolInventory({ surface, registry: runtime.contributes, pluginToolCatalog });
        const expectedToolNames = (surface === 'mcp' ? ['qa_pending_other', toolName] : [toolName]).sort();
        expect(inventory.tools.filter(tool => tool.toolId?.startsWith(`${pluginId}/`)).map(tool => tool.name).sort())
          .toEqual(expectedToolNames);
        registerHappierMcpBuiltInTools(server, {
          sessionId: 'requesting-session', surface, pluginToolCatalog,
          // Exercise these real bindings and generic Action dispatch without
          // serializing every unrelated built-in schema on each surface.
          toolInventory: prepareHappierMcpToolInventory({ inventory: { ...inventory,
            tools: inventory.tools.filter(tool => tool.name === 'action_execute' || tool.toolId?.startsWith(`${pluginId}/`)),
          }, sessionId: 'requesting-session' }),
          deps: { ...bridge, changeTitle: async () => { throw new Error('Unexpected title change'); } },
        });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await server.connect(serverTransport);
        await client.connect(clientTransport);
        const listed = await client.listTools();
        expect(listed.tools.filter(tool => tool.name.startsWith('qa_pending_')).map(tool => tool.name).sort())
          .toEqual(expectedToolNames);
        const actionId = `${pluginId}/actions/publish`;
        const input = { label: 'Reviewed label' };
        for (const [name, args] of [
          [toolName, input],
          ['action_execute', { actionId, input }],
        ] as const) {
          const response = await client.callTool({ name, arguments: args });
          const content = response.content;
          if (!Array.isArray(content) || content[0]?.type !== 'text') throw new Error('Expected MCP text result');
          const payload: unknown = JSON.parse(content[0].text);
          const errorCode = payload && typeof payload === 'object' && 'errorCode' in payload ? payload.errorCode : null;
          expect.soft({ isError: response.isError, errorCode }, `${name}: ${unavailableReasons.join(',')}`).toEqual({ isError: false, errorCode: null });
          if (response.isError) continue;
          const pending = ActionApprovalRequestCreatedResultSchema.parse(payload);
          expect(pending).toMatchObject({ kind: 'approval_request_created' });
          const artifact = artifacts.get(pending.artifactId);
          if (!artifact) throw new Error('Expected persisted approval Artifact');
          const header = z.record(z.string(), z.unknown()).parse(decodePlainArtifactStoredContent(artifact.header));
          const { body } = z.object({ body: z.string() }).parse(decodePlainArtifactStoredContent(artifact.body));
          const parsed = approvalArtifactBodyMatchesHeaderV1(header, body);
          if (parsed?.family !== 'target_action') throw new Error('Expected matching target approval header and body');
          const stored = TargetActionApprovalRequestV1Schema.parse(parsed.request);
          expect({ status: stored.status, actionId: stored.qualifiedActionId }).toEqual({ status: 'open', actionId });
          expect.soft(header).toMatchObject({ serverIdentityId, machineId: 'pending-machine' });
          expect.soft(stored.executionOriginV1).toMatchObject({ serverId: configuration.activeServerId, serverIdentityId });
          const route = resolveApprovalReplayRoute(stored);
          expect.soft(route).toEqual({ serverId: savedHomeId, serverIdentityId, originServerId: configuration.activeServerId });
          expect.soft(buildApprovalHref(pending.artifactId, String(header.serverIdentityId)))
            .toBe(`/inbox/approvals/${pending.artifactId}?serverId=${serverIdentityId}`);
          if (surface === 'agent' && name === 'action_execute') {
            const profile = getServerProfileById(serverIdentityId);
            if (!profile) throw new Error('Expected saved fixture Home');
            await removeServerProfile(profile.id);
            expect(resolveApprovalReplayRoute(stored)).toBeNull();
            await upsertServerProfile({ serverUrl: serverHttpBaseUrl, source: 'manual' });
            await setServerProfileIdentityForUrl(serverHttpBaseUrl, serverIdentityId);
          }
          if (name === toolName) expect(response.structuredContent).toEqual(pending);
        }
        const native = await bridge.executeActionByToolName(toolName, input, 'requesting-session');
        expect(native, JSON.stringify(native)).toMatchObject({ ok: true });
        if (!native.ok) throw new Error(native.errorCode);
        expect(ActionApprovalRequestCreatedResultSchema.safeParse(native.result).success).toBe(true);
      } finally { await client.close(); await server.close(); }
      expect(created).toBe(before + 3);
      expect(originReads - originReadsBefore).toBe(created - before);
  });

  it('preserves a captured requester Home instead of replacing it with the target Home', async () => {
    if (!fixture) throw new Error('Expected admitted plugin runtime');
    const action = { pluginId, localId: 'publish' };
    const input = { label: 'Captured requester' };
    const approvalExecutionOrigin = buildApprovalExecutionOriginV1({ actionId: 'action.invoke', input: { action, input },
      targetSessionId: 'requesting-session', context: { surface: 'agent', serverId: configuration.activeServerId,
        serverIdentityId: 'srv_original_requester', actionRequestId: 'captured-request',
        executionRunTargetMachineId: 'pending-machine', actionCaller: { kind: 'host' } } });
    if (!approvalExecutionOrigin) throw new Error('Expected captured requester origin');
    const result = await executeContributedAction({ runtimeRegistry: fixture.registry,
      actionId: buildQualifiedPluginContributionKey(action), input, requestCurrentIntent, approvalExecutionOrigin,
      context: { surface: 'agent', defaultSessionId: 'requesting-session' } });
    expect(result).toMatchObject({ matched: true, result: { ok: true } });
    if (!result.matched || !result.result.ok) throw new Error('Expected pending approval');
    const pending = ActionApprovalRequestCreatedResultSchema.parse(result.result.result);
    const stored = await runWithServerHttpBaseUrl(serverHttpBaseUrl, () => store.targetActionApprovalsGet({ artifactId: pending.artifactId }));
    expect(stored?.executionOriginV1).toEqual(approvalExecutionOrigin);
    expect(resolveApprovalReplayRoute(stored)).toBeNull();
  });
});
