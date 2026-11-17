import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { ACTION_IDS, getActionSpec, normalizeActionsSettingsV1, RPC_METHODS, SignedRootActionIdSchema, UiActionDispatchRequestV1Schema, V2SessionByIdResponseSchema, type ActionExecutorDeps } from '@happier-dev/protocol';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { REGISTRY_ACTION_IDS_V1 } from '@happier-dev/protocol/registries';
import { getUsageQueryKey, normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { UsageCoachDismissInputSchema, UsageCoachPreferenceResultSchema } from '@happier-dev/protocol/usage/coach/coachActions';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createDaemonControlApp } from '@/daemon/controlServer';
import { createDaemonExternalActionTargetResolver } from '@/daemon/externalActions/daemonExternalActionTargetResolver';
import { SignedRootActionExecuteRequestSchema } from '@/daemon/externalActions/signedRootActionControl';
import { createCliActionExecutorHarness } from '@/session/actions/createCliActionExecutorHarness';
import { createClientActionReverseDispatcher } from '@/session/actions/clientActionReverseDispatch';
import { configuration } from '@/configuration';
import { writeStoredCredentialsForServerId } from '@/persistence';
import { adoptServerProfileHomeConnectionDescriptor, getServerProfile } from '@/server/serverProfiles';
import { createExternalMcpServer } from './createExternalMcpServer';
import { definePlugin } from '@happier-dev/plugin-sdk';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createCliRegistryHostV1 } from '@/registries/createCliRegistryHost';
import { StoredPromptLibraryRecordV1Schema, PromptLibraryCatalogKeyV1Schema, PromptLibraryRowsListResponseV1Schema } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { setActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { ApprovalRequestV2Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { createDeploymentEnvironmentHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import { ExternalActionExecutionAuthorizationRequestV1Schema, ExternalActionExecutionAuthorizationV1Schema,
  createDeploymentCandidatePublicationV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { ed25519 } from '@noble/curves/ed25519';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol';

const credentials = { token: 'mcp-test-token', encryption: null, credentialProvenance: 'stored_session' } as const;
const workspace = { ok: true, tabs: [], groups: [], splits: [], rootNodeId: 'main', focusedGroupId: 'main', maximizedGroupId: null };

describe('standalone MCP client Action admission', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); resetActiveAccountSettingsSnapshotForTests(); });

  it('keeps waived public-link opening material out of the standalone MCP result', async () => {
    const accountId = 'mcp-link-owner';
    const token = `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
    const credentials = { token, encryption: null, credentialProvenance: 'stored_session' } as const;
    const artifactId = 'mcp-shareable-artifact';
    const settings = normalizeActionsSettingsV1({ v: 1, actions: {},
      approvalWaivedSurfaces: { 'artifact.public_link.create': ['mcp'] } });
    vi.stubEnv('HAPPIER_ACTIONS_SETTINGS_V1', JSON.stringify(settings));
    const publicShare = { id: 'mcp-public-share', subject: { kind: 'artifact', id: artifactId },
      expiresAt: null, maxUses: null, useCount: 0, isConsentRequired: false, networkOff: false,
      createdAt: 1, updatedAt: 1, keyDerivation: 'fragment_v1' };
    // Home HTTP and the connected App RPC are boundaries. Placement, waived
    // approval, MCP formatting, daemon ingress and reverse dispatch stay real.
    const home = createServer((request, response) => {
      request.resume();
      const path = new URL(request.url ?? '/', 'http://localhost').pathname;
      response.setHeader('content-type', 'application/json');
      if (path === '/v1/account/profile') response.end(JSON.stringify({ id: accountId }));
      else if (path === '/v1/account/encryption/currentness') response.end(JSON.stringify({
        mode: 'plain', version: 1, updatedAt: 1, signingKeyFingerprint: null, contentKeyFingerprint: null }));
      else if (path === '/v1/account/encryption') response.end(JSON.stringify({ mode: 'plain', updatedAt: 1 }));
      else if (path === '/v2/account/settings') response.end(JSON.stringify({ version: 1,
        content: { t: 'plain', v: { actionsSettingsV1: settings } } }));
      else if (path === `/v1/artifacts/${artifactId}`) response.end(JSON.stringify({
        id: artifactId, ownerAccountId: accountId, access: 'owner', encryptionMode: 'plain',
        header: encodePlainArtifactStoredContent({ kind: 'html', title: 'MCP visual', requestedCapabilities: { network: 'open' } }),
        body: encodePlainArtifactStoredContent({ body: '<p>MCP visual</p>', mime: 'text/html' }),
        dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, headerVersion: 1, bodyVersion: 1,
        seq: 1, createdAt: 1, updatedAt: 1,
      }));
      else if (path === '/v1/public-shares') response.end(JSON.stringify({ publicShare,
        viewerOrigin: 'https://public.example.test' }));
      else { response.statusCode = 404; response.end(JSON.stringify({ error: 'unexpected_route' })); }
    });
    home.listen(0, '127.0.0.1'); await once(home, 'listening');
    const homeAddress = home.address();
    if (!homeAddress || typeof homeAddress === 'string') throw new Error('Missing Home address');
    const serverHttpBaseUrl = `http://127.0.0.1:${homeAddress.port}`;
    await writeStoredCredentialsForServerId(configuration.activeServerId, credentials);
    const deliveries: string[] = [];
    const clientActionExecute = createClientActionReverseDispatcher(() => ({
      hasConnectedClientRpcHandler: () => true,
      callConnectedClientRpc: async (_method, raw, options) => {
        const dispatch = UiActionDispatchRequestV1Schema.parse(raw);
        deliveries.push(dispatch.actionId); options.onIssued();
        // The App owns private link delivery; its published result omits url.
        return { ok: true, result: { v: 1, execution: { ok: true, result: { publicShare } } } };
      },
    }));
    const { executor } = createCliActionExecutorHarness({ token, credentials, sessionId: '',
      mode: 'plain', ctx: null, serverId: configuration.activeServerId, serverHttpBaseUrl,
      actionsSettingsProvider: { getActionsSettings: () => settings },
    }, { clientActionExecute });
    const app = createDaemonControlApp({ getChildren: () => [], machineId: 'mcp-link-machine',
      controlToken: 'private-link-control', stopSession: async () => ({ status: 'not_found' }),
      spawnSession: async () => ({ type: 'success', sessionId: 'unused' }),
      requestShutdown: () => {}, onHappySessionWebhook: () => {}, externalActionApi: {
        currentServerId: configuration.activeServerId, executor,
        verifyPat: async () => { throw new Error('Account MCP must not use PAT admission'); },
        resolveTarget: createDaemonExternalActionTargetResolver({ credentials, serverApiUrl: serverHttpBaseUrl }),
      } });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('Missing daemon address');
    const { mcp } = runWithServerHttpBaseUrl(serverHttpBaseUrl, () => createExternalMcpServer({
      credentials, machineId: 'mcp-link-machine',
      daemonControlTarget: { pid: process.pid, httpPort: address.port, controlToken: 'private-link-control' },
    }));
    const client = new Client({ name: 'standalone-public-link', version: '1' });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    try {
      await mcp.connect(serverTransport); await client.connect(clientTransport);
      const result = CallToolResultSchema.parse(await client.callTool({ name: 'action_execute',
        arguments: { actionId: 'artifact.public_link.create', input: { artifactId } } }));
      expect(result.isError === true).toBe(false);
      // Assert a boolean so a regression never prints opening material.
      expect(JSON.stringify(result).includes('#k=')).toBe(false);
      expect(deliveries).toEqual(['artifact.public_link.create']);
      const content = result.content.find(item => item.type === 'text');
      const payload: unknown = content?.type === 'text' ? JSON.parse(content.text) : null;
      expect(typeof payload === 'object' && payload !== null && 'publicShare' in payload).toBe(true);
    } finally {
      await client.close(); await mcp.close(); await app.close();
      home.closeAllConnections(); await new Promise<void>(resolve => home.close(() => resolve()));
    }
  });

  it.each([{ denied: false }, { denied: true }])('delivers compact Deploy to the Environment controller before originating Ask (denied=$denied)', async ({ denied }) => {
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'deployment-owner', tokenEpoch: 1,
      provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`;
    const credentials = { token, encryption: null, credentialProvenance: 'stored_session' } as const;
    const controller = { id: 'native-controller', kind: 'persistent', active: true, installationId: 'native-installation',
      installationPublicKey: Buffer.from(ed25519.getPublicKey(new Uint8Array(32).fill(19))).toString('base64'),
      revokedAt: null, replacedByMachineId: null, storageMode: 'plain',
      access: { custodian: { accountId: 'deployment-owner', displayName: 'Owner' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' } };
    const environment = createDeploymentEnvironmentHeaderV1({ id: 'staging', serverId: configuration.activeServerId, controllerMachineId: controller.id });
    const deliveries: ReturnType<typeof ExternalActionExecutionAuthorizationRequestV1Schema.parse>[] = [];
    const writes: string[] = [];
    // Home HTTP is the boundary; MCP, original Account dispatch, controller
    // selection, envelope binding and installation-sealed requester custody stay real.
    const home = createServer(async (request, response) => {
      response.setHeader('content-type', 'application/json');
      const path = new URL(request.url ?? '/', 'http://localhost').pathname;
      if (request.method !== 'GET') writes.push(path);
      if (path === '/v1/account/encryption/currentness') response.end(JSON.stringify({ mode: 'plain', version: 1,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 }));
      else if (path === '/v1/account/encryption') response.end(JSON.stringify({ mode: 'plain', updatedAt: 1 }));
      else if (path === '/v1/machines') response.end(JSON.stringify([controller]));
      else if (path === `/v1/machines/${controller.id}`) response.end(JSON.stringify({ machine: controller }));
      else if (path === '/v1/deployments/environments/staging') response.end(JSON.stringify(denied
        ? { ok: false, error: 'deployment_access_denied' } : { ok: true, environment, targetLinks: [] }));
      else if (path.startsWith('/v1/actions/deployments.deploy')) {
        const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const carrier = ExternalActionExecutionAuthorizationRequestV1Schema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        const requestId = carrier.envelope.requestId!;
        if (path.endsWith('/execution-authorization')) response.end(JSON.stringify(ExternalActionExecutionAuthorizationV1Schema.parse({
          v: 1, token: 'native-home-proof', binding: { accountId: 'deployment-owner', authentication: { kind: 'account', tokenEpoch: 1 },
            accountEncryptionMode: 'plain', serverIdentityId: 'srv_relay', custodianAccountId: 'deployment-owner',
            machineId: controller.id, installationId: controller.installationId, actionId: 'deployments.deploy', requestId,
            target: carrier.envelope.target, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(carrier.envelope),
            deploymentCandidatePublication: createDeploymentCandidatePublicationV1({ accountId: 'deployment-owner',
              serverIdentityId: 'srv_relay', actionId: 'deployments.deploy', requestId,
              requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(carrier.envelope), environmentId: environment.id,
              source: { id: environment.projectSourceId, revision: 1 } }),
          },
        })));
        else { deliveries.push(carrier); response.end(JSON.stringify({ v: 1, actionId: 'deployments.deploy', requestId,
          execution: { ok: true, result: { kind: 'approval_request_created', artifactId: 'native-review', actionId: 'deployments.deploy' } } })); }
      } else { request.resume(); response.statusCode = 404; response.end(JSON.stringify({ error: 'unexpected_route' })); }
    });
    home.listen(0, '127.0.0.1'); await once(home, 'listening');
    const address = home.address(); if (!address || typeof address === 'string') throw new Error('Missing Home address');
    const serverHttpBaseUrl = `http://127.0.0.1:${address.port}`;
    const { mcp } = runWithServerHttpBaseUrl(serverHttpBaseUrl, () => createExternalMcpServer({ credentials,
      machineId: 'ambient-invoker', daemonControlTarget: null,
      serverFeaturesSnapshot: { status: 'ready', features: FeaturesResponseSchema.parse({ features: { deployments: { enabled: true } },
        capabilities: { serverIdentity: { serverIdentityId: 'srv_relay' } } }) } }));
    const client = new Client({ name: 'standalone-deploy-review', version: '1' });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    try {
      await mcp.connect(serverTransport); await client.connect(clientTransport);
      const input = { serverId: configuration.activeServerId, environmentId: 'staging', targetLinkId: 'runtime-link', requestKey: 'compact-deploy' };
      const result = CallToolResultSchema.parse(await client.callTool({ name: 'action_execute',
        arguments: { actionId: 'deployments.deploy', input } }));
      if (denied) {
        expect(result.isError, JSON.stringify(result)).toBe(true);
        const content = result.content.find(item => item.type === 'text');
        expect(content?.type === 'text' ? JSON.parse(content.text) : null).toMatchObject({ errorCode: 'deployment_access_denied' });
        expect(deliveries).toEqual([]);
        expect(writes).toEqual([]);
        return;
      }
      expect(deliveries, JSON.stringify({ result, writes })).toHaveLength(1);
      expect(deliveries[0]?.envelope).toMatchObject({ input, target: { kind: 'machine', machineId: controller.id } });
      expect(deliveries[0]?.executionAuthorization?.requesterAccountContext).toBeDefined();
      expect(writes).toEqual(['/v1/actions/deployments.deploy/execution-authorization', '/v1/actions/deployments.deploy']);
      const content = result.content.find(item => item.type === 'text');
      expect(result.isError).not.toBe(true);
      expect(content?.type === 'text' ? JSON.parse(content.text) : null).toMatchObject({ kind: 'approval_request_created', artifactId: 'native-review' });
    } finally {
      await client.close(); await mcp.close(); home.closeAllConnections();
      await new Promise<void>(resolve => home.close(() => resolve()));
    }
  });

  it('requests default Ask for standalone Saved Secret Reveal without a Session or secret disclosure', async () => {
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'reveal-owner', tokenEpoch: 1,
      provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`;
    const credentials = { token, encryption: null, credentialProvenance: 'stored_session' } as const;
    const requests: string[] = [];
    const approvals: ReturnType<typeof ApprovalRequestV2Schema.parse>[] = [];
    const displays: unknown[] = [];
    // Only Home HTTP, approval persistence and the connected app RPC are boundaries.
    // MCP, daemon control, the Action executor and default Ask policy stay real.
    const home = createServer((request, response) => {
      request.resume(); requests.push(request.url ?? '');
      response.setHeader('content-type', 'application/json');
      if (request.url === '/v1/account/encryption/currentness') response.end(JSON.stringify({
        mode: 'plain', version: 1, updatedAt: 1, signingKeyFingerprint: null, contentKeyFingerprint: null,
      }));
      else if (request.url === '/v1/account/encryption') response.end(JSON.stringify({ mode: 'plain', updatedAt: 1 }));
      else { response.statusCode = 404; response.end(JSON.stringify({ error: 'unexpected_route' })); }
    });
    home.listen(0, '127.0.0.1'); await once(home, 'listening');
    const homeAddress = home.address();
    if (!homeAddress || typeof homeAddress === 'string') throw new Error('Missing Home address');
    const serverHttpBaseUrl = `http://127.0.0.1:${homeAddress.port}`;
    await writeStoredCredentialsForServerId(configuration.activeServerId, credentials);
    const clientActionExecute = createClientActionReverseDispatcher(() => ({
      hasConnectedClientRpcHandler: () => true,
      callConnectedClientRpc: async (_method, raw, options) => {
        displays.push(UiActionDispatchRequestV1Schema.parse(raw)); options.onIssued();
        return { ok: true, result: { v: 1, execution: { ok: true,
          result: { status: 'hidden', historyEntryId: 'reveal-history' } } } };
      },
    }));
    const { executor } = createCliActionExecutorHarness({ token, credentials, sessionId: '',
      mode: 'plain', ctx: null, serverId: configuration.activeServerId, serverHttpBaseUrl,
    }, { clientActionExecute, approvalsCreate: async ({ request }) => {
      approvals.push(ApprovalRequestV2Schema.parse(request)); return { artifactId: 'reveal-approval' };
    } });
    const app = createDaemonControlApp({
      getChildren: () => [], machineId: 'mcp-reveal-machine', controlToken: 'private-reveal-control',
      stopSession: async () => ({ status: 'not_found' }),
      spawnSession: async () => ({ type: 'success', sessionId: 'unused' }),
      requestShutdown: () => {}, onHappySessionWebhook: () => {},
      externalActionApi: { currentServerId: configuration.activeServerId, executor,
        verifyPat: async () => { throw new Error('Reveal must not use PAT admission'); },
        resolveTarget: createDaemonExternalActionTargetResolver({ credentials, serverApiUrl: serverHttpBaseUrl }),
      },
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('Missing daemon address');
    const { mcp } = runWithServerHttpBaseUrl(serverHttpBaseUrl, () => createExternalMcpServer({
      credentials, machineId: 'mcp-reveal-machine',
      daemonControlTarget: { pid: process.pid, httpPort: address.port, controlToken: 'private-reveal-control' },
    }));
    const client = new Client({ name: 'standalone-reveal-ask', version: '1' });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    try {
      await mcp.connect(serverTransport); await client.connect(clientTransport);
      const input = { ref: 'happier:shared-secret:v1:owned-secret', expectedRevision: 3 };
      const result = CallToolResultSchema.parse(await client.callTool({ name: 'action_execute',
        arguments: { actionId: 'secrets.shared.reveal', input } }));
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      const text = result.content.find(item => item.type === 'text');
      if (!text || text.type !== 'text') throw new Error('Missing MCP result');
      expect(JSON.parse(text.text)).toMatchObject({ kind: 'approval_request_created', artifactId: 'reveal-approval' });
      expect(approvals).toHaveLength(1);
      expect(approvals[0]).toMatchObject({ actionId: 'secrets.shared.reveal', actionArgs: input,
        status: 'open', approval: { flow: 'deferred', result: 'optional' }, requestedSurface: 'mcp' });
      expect(approvals[0]?.executionOriginV1.caller).toEqual({ kind: 'host' });
      expect(displays).toEqual([]);
      expect(requests.some(path => path.includes('/sessions/') || path.includes('/saved-secrets/'))).toBe(false);
      expect(JSON.stringify({ result, approvals })).not.toContain('"value"');
    } finally {
      await client.close(); await mcp.close(); await app.close();
      home.closeAllConnections(); await new Promise<void>(resolve => home.close(() => resolve()));
    }
  });

  it('keeps every relayed MCP client or registry Action in the existing signed Account admission vocabulary', () => {
    const ids = ACTION_IDS.filter(id => getActionSpec(id).surfaces.mcp && (
      getActionSpec(id).executionPlacement === 'client' || REGISTRY_ACTION_IDS_V1.some(registryId => registryId === id)
    ));
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.filter(id => !SignedRootActionIdSchema.safeParse(id).success)).toEqual([]);
  });

  it.each([...[true, false].flatMap(connected => [
    { connected, family: 'existing clients' },
    { connected, family: 'prompt picker, history and pins' },
  ]), { connected: true, family: 'packaged app registries' }])('delivers $family through the exact daemon and preserves MCP authority (connected=$connected)', async ({ connected, family }) => {
    const admitted: unknown[] = [];
    const daemonAdmissions: unknown[] = [];
    const homeSessionLookups: string[] = [];
    const authored = definePlugin({ id: 'com.acme.registry-parity', version: '1.0.0', displayName: 'Apps', registrySources: {
      apps: { title: 'Apps', format: 'happier-catalog', kinds: ['app'], packageContent: { path: 'resources/apps.json' } },
    } });
    const appTemplate = { schemaVersion: 1, title: 'Database', compose: { document: 'services:\n  db:\n    image: postgres:17\n', profiles: [], services: ['db'] },
      variables: [], generatedSecrets: [], domains: [], volumes: [] };
    const runtime = family === 'packaged app registries' ? await createAuthoredAdmittedPluginRuntimeFixture({
      plugins: [{ manifest: authored.manifest, files: { 'resources/apps.json': JSON.stringify({ schemaVersion: 1, apps: [{ itemId: 'database', app: appTemplate }] }) } }],
      coldStart: true,
    }) : null;
    // Persisted catalog rows and physical plugin files are the boundaries;
    // registry admission, pinning, normalization and dispatch stay real.
    let registryRecord = StoredPromptLibraryRecordV1Schema.parse({ key: 'registry-sources', value: { v: 2, sources: [], disabledSourceIds: [] } });
    let registryRevision = 1;
    const registryCatalog = { status: 'ready' as const, rows: [{ revision: 1, record: registryRecord }], tombstones: [], diagnostics: [] };
    const registry = runtime ? createCliRegistryHostV1({ pluginRuntime: runtime.controller, port: {
      serverId: 'mcp-home', assertCurrent() {},
      async readCatalog() { return { catalog: registryCatalog }; },
      async writeRecord(request) {
        expect(request.expectedRevision).toBe(registryRevision);
        registryRecord = StoredPromptLibraryRecordV1Schema.parse(request.record);
        registryRevision += 1;
        registryCatalog.rows = [{ record: registryRecord, revision: registryRevision }];
        return { status: 'updated' as const, revision: registryRevision, cursor: registryRevision };
      },
    } }) : null;
    const coachQuery = normalizeUsageQuery({ session: 'mcp-session-active' });
    const coachInput = { query: coachQuery, evidenceKey: 'relay-coach-evidence', dismissed: true };
    const coachResult = UsageCoachPreferenceResultSchema.parse({
      kind: 'preference_updated', evidenceKey: coachInput.evidenceKey, dismissed: true,
    });
    // This is the persisted Account declaration parsed by the real settings
    // owner, not an approval token or an executor admission override.
    const accountSettings = accountSettingsParse({ actionsSettingsV1: {
      v: 1, actions: {}, approvalWaivedSurfaces: { 'usage.coach.dismiss': ['mcp'],
        'ui.prompts.picker.apply': ['mcp'], 'workspace.tabs.open': ['mcp'], 'registries.sources.update': ['mcp'] },
    } });
    const waivedSettings = normalizeActionsSettingsV1(accountSettings.actionsSettingsV1);
    let reviewedSettings = normalizeActionsSettingsV1({});
    vi.stubEnv('HAPPIER_ACTIONS_SETTINGS_V1', JSON.stringify(waivedSettings));
    if (!SignedRootActionIdSchema.safeParse('usage.coach.dismiss').success) {
      throw new Error('Coach dismissal is not admitted by the existing signed Account vocabulary');
    }
    // vitestSetup owns this process's temporary Home. Persist the genuine
    // credential fixture so a missing relay is not masked by a retired lease.
    await writeStoredCredentialsForServerId(configuration.activeServerId, credentials);
    let clientAvailable = connected;
    let primarySessionId: string | null = 'canonical-session';
    const portableHomeId = 'srv_mcp_cursor';
    let primaryServerId = portableHomeId;
    const dashboardInput = { surface: { serverId: configuration.activeServerId, accountId: 'viewer',
      owner: { kind: 'corePage', pageId: 'usage', area: 'main', layoutId: 'costs' } } };
    const dashboardResult = getActionSpec('widgets.area.layout.select').outputSchema!.parse({
      ...dashboardInput,
    });
    const workspaceOpened = getActionSpec('workspace.tabs.open').outputSchema!.parse({ ok: true });
    // The Home HTTP service is a network boundary. Session parsing, Account
    // mode and daemon locality resolution use their real canonical owners.
    const home = createServer((request, response) => {
      request.resume();
      const path = new URL(request.url ?? '/', 'http://localhost').pathname;
      response.setHeader('content-type', 'application/json');
      if (path === '/v1/account/encryption/currentness') {
        response.end(JSON.stringify({ mode: 'plain', version: 1, updatedAt: 1,
          signingKeyFingerprint: null, contentKeyFingerprint: null }));
      } else if (path === '/v1/account/encryption') {
        response.end(JSON.stringify({ mode: 'plain', updatedAt: 1 }));
      } else if (registry && path === '/v1/account/entity-rows/prompt-library') {
        response.end(JSON.stringify(PromptLibraryRowsListResponseV1Schema.parse({ status: 'listed', rows:
          PromptLibraryCatalogKeyV1Schema.options.map(key => ({ key, revision: key === 'registry-sources' ? registryRevision : 1,
            content: key === 'registry-sources' ? { t: 'plain', v: registryRecord } : null })) })));
      } else if (path.startsWith('/v2/sessions/')) {
        homeSessionLookups.push(path);
        response.end(JSON.stringify(V2SessionByIdResponseSchema.parse({ session: {
          id: decodeURIComponent(path.slice('/v2/sessions/'.length)), seq: 1, createdAt: 1, updatedAt: 1,
          active: true, activeAt: 1, encryptionMode: 'plain', metadataVersion: 1,
          metadata: JSON.stringify({ machineId: 'mcp-machine' }), dataEncryptionKey: null,
          agentState: null, agentStateVersion: 1,
        } })));
      } else { response.statusCode = 404; response.end(JSON.stringify({ error: 'Unexpected test Home route' })); }
    });
    home.listen(0, '127.0.0.1');
    await once(home, 'listening');
    const homeAddress = home.address();
    if (!homeAddress || typeof homeAddress === 'string') throw new Error('Missing Home address');
    const previousProfile = await getServerProfile(configuration.activeServerId).catch(() => null);
    await adoptServerProfileHomeConnectionDescriptor({ expectedProfileId: configuration.activeServerId,
      createIfMissing: true, observation: 'exact', descriptor: { v: 1, homeServerIdentityId: portableHomeId,
        canonicalServerUrl: `http://127.0.0.1:${homeAddress.port}`, revision: (previousProfile?.homeConnectionDescriptor?.revision ?? 0) + 1,
        endpoints: [{ kind: 'https', url: `http://127.0.0.1:${homeAddress.port}` }] } });
    if (registry) setActiveAccountSettingsSnapshot({ source: 'network',
      scopeKey: runWithServerHttpBaseUrl(`http://127.0.0.1:${homeAddress.port}`, () => resolveAccountSettingsScopeKey(credentials)),
      settings: accountSettings, rawSettings: {}, settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [], promptLibraryCatalog: registryCatalog });
    // The connected-client RPC is the network boundary. Admission, placement,
    // reverse dispatch, daemon HTTP and MCP SDK execution remain real.
    const clientActionExecute = createClientActionReverseDispatcher(() => ({
      hasConnectedClientRpcHandler: () => clientAvailable,
      callConnectedClientRpc: async (method, raw, options) => {
        if (!clientAvailable) return { ok: false, errorCode: 'RPC_CLIENT_NOT_AVAILABLE' };
        const request = UiActionDispatchRequestV1Schema.parse(raw);
        // The App is on Usage, so its Session-specific room is not mounted.
        if ((request.actionId === 'widgets.area.layout.select' || request.actionId === 'workspace.tabs.open')
          && method !== RPC_METHODS.UI_ACTION_EXECUTE) {
          return { ok: false, errorCode: 'RPC_CLIENT_NOT_AVAILABLE' };
        }
        if (request.actionId === 'workspace.tabs.open') {
          expect(options.answeringClient).toEqual({ clientId: 'usage-app', requireSingle: true });
        }
        admitted.push(request);
        options.onIssued();
        const result = request.actionId === 'widgets.item.inputs.get' ? {
          ref: typeof request.input === 'object' && request.input !== null ? Reflect.get(request.input, 'ref') : undefined,
          bindings: {},
        }
          : request.actionId === 'widgets.area.layout.select' ? dashboardResult
          : request.actionId === 'workspace.tabs.open' ? workspaceOpened
          : request.actionId === 'ui.find' ? { status: 'idle' }
          : request.actionId === 'ui.prompts.picker.select' ? { status: 'selected', composerRef: { kind: 'session', sessionId: 'mcp-session-active' } }
          : request.actionId === 'ui.prompts.picker.apply' ? { status: 'applied', composerRef: { kind: 'session', sessionId: 'mcp-session-active' } }
          : request.actionId === 'ui.prompts.history' ? { status: 'ready', composerRef: { kind: 'session', sessionId: 'mcp-session-active' },
            entries: [], coverage: 'loaded', hasMore: true, isLoading: false, error: false, progress: { pagesLoaded: 0, sessionsSearched: 0, totalSessions: 1 } }
          : request.actionId === 'session.messages.pins' ? { status: 'ready', sessionId: 'mcp-session-active', pins: [] }
          : request.actionId === 'session.pending.next' ? { status: 'none' }
          : request.actionId === 'usage.coach.dismiss' ? coachResult
          : request.actionId === 'session.target.primary.set' ? { ok: true, status: 'ok',
            sessionId: primarySessionId, serverId: primarySessionId ? primaryServerId : null,
            address: primarySessionId ? { sessionId: primarySessionId, serverId: primaryServerId } : null } : workspace;
        return { ok: true, result: { v: 1, execution: { ok: true, result } } };
      },
    }));
    const { executor } = createCliActionExecutorHarness({
      token: credentials.token, credentials, sessionId: '', mode: 'plain', ctx: null,
      serverId: 'mcp-home',
      serverHttpBaseUrl: `http://127.0.0.1:${homeAddress.port}`,
      // A reviewed runtime with no Account approval carrier fails closed for
      // danger Actions, without reaching an external service in this test.
      actionsSettingsProvider: { getActionsSettings: () => reviewedSettings },
    }, { clientActionExecute, ...(registry ? { registryActionExecute: async (request: Parameters<NonNullable<ActionExecutorDeps['registryActionExecute']>>[0]) => registry.execute(request.actionId, request.input) } : {}) });
    const app = createDaemonControlApp({
      getChildren: () => [], machineId: 'mcp-machine', controlToken: 'private-mcp-control',
      stopSession: async () => ({ status: 'not_found' }),
      spawnSession: async () => ({ type: 'success', sessionId: 'unused' }),
      requestShutdown: () => {}, onHappySessionWebhook: () => {},
      externalActionApi: {
        currentServerId: 'mcp-home', executor,
        verifyPat: async () => { throw new Error('Account MCP must not use PAT admission'); },
        resolveTarget: createDaemonExternalActionTargetResolver({ credentials, serverApiUrl: `http://127.0.0.1:${homeAddress.port}` }),
      },
    });
    app.addHook('preHandler', async request => {
      if (request.url === '/actions/root/execute') daemonAdmissions.push(request.body);
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('Missing daemon address');
    const { mcp } = runWithServerHttpBaseUrl(`http://127.0.0.1:${homeAddress.port}`, () => createExternalMcpServer({ credentials, defaultSessionId: 'mcp-session-active', machineId: 'mcp-machine',
      daemonControlTarget: { pid: process.pid, httpPort: address.port, controlToken: 'private-mcp-control' },
    }));
    const client = new Client({ name: 'standalone-client-relay-test', version: '1' });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await mcp.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      if (registry) {
        // Acquisition timestamps are clock facts, not registry-content parity.
        vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
        const sourceId = `${authored.manifest.id}/apps`;
        const cliSources = await registry.execute('registries.sources.list', { kind: 'app' });
        expect(cliSources).toMatchObject({ sources: expect.arrayContaining([expect.objectContaining({ id: sourceId })]) });
        const invoke = async (actionId: string, input: unknown) => {
          const response = CallToolResultSchema.parse(await client.callTool({ name: 'action_execute', arguments: { actionId, input } }));
          const text = response.content.find(entry => entry.type === 'text');
          if (!text || text.type !== 'text') throw new Error('Missing registry result');
          return JSON.parse(text.text) as unknown;
        };
        expect(await invoke('registries.sources.list', { kind: 'app' })).toEqual(cliSources);
        const browse = { kind: 'app', sourceIds: [sourceId] };
        expect(await invoke('registries.items.list', browse)).toEqual(await registry.execute('registries.items.list', browse));
        const selection = { kind: 'app', sourceId, itemId: 'database', version: '1.0.0' };
        const cliRead = await registry.execute('registries.items.read', selection);
        expect(cliRead).toMatchObject({ item: { payload: { kind: 'app', state: 'ready', app: appTemplate } } });
        expect(await invoke('registries.items.read', selection)).toEqual(cliRead);
        reviewedSettings = waivedSettings;
        expect(await invoke('registries.sources.update', { sourceId, enabled: false }))
          .toMatchObject({ source: { id: sourceId, enabled: false } });
        expect(registryRecord).toMatchObject({ key: 'registry-sources', value: { disabledSourceIds: [sourceId] } });
        const disabledSources = await registry.execute('registries.sources.list', { kind: 'app' });
        expect(disabledSources).toMatchObject({ sources: expect.arrayContaining([expect.objectContaining({ id: sourceId, enabled: false })]) });
        expect(await invoke('registries.sources.list', { kind: 'app' })).toEqual(disabledSources);
        expect(await invoke('registries.sources.update', { sourceId, enabled: true }))
          .toMatchObject({ source: { id: sourceId, enabled: true } });
        expect(await invoke('registries.items.read', selection)).toEqual(cliRead);
        expect(daemonAdmissions).toEqual(['registries.sources.list', 'registries.items.list', 'registries.items.read',
          'registries.sources.update', 'registries.sources.list', 'registries.sources.update', 'registries.items.read']
          .map(actionId => expect.objectContaining({ actionId, surface: 'mcp', target: { kind: 'machine', machineId: 'mcp-machine' } })));
        return;
      }
      if (family === 'prompt picker, history and pins') {
        reviewedSettings = waivedSettings;
        // Keep this family's deciding MCP journey independent of other client
        // families while reusing the same real daemon/admission harness.
        for (const [actionId, input, status] of [
          ['ui.prompts.picker.select', { selection: { kind: 'doc', artifactId: 'prompt' } }, 'selected'],
          ['ui.prompts.picker.apply', { mode: 'insert' }, 'applied'],
          ['ui.prompts.history', { op: 'read' }, 'ready'],
          ['session.messages.pins', { op: 'read', sessionId: 'mcp-session-active' }, 'ready'],
        ] as const) {
          const response = CallToolResultSchema.parse(await client.callTool({ name: 'action_execute', arguments: { actionId, input } }));
          const text = response.content.find(entry => entry.type === 'text');
          if (!text || text.type !== 'text') throw new Error('Missing prompt/pin MCP result');
          expect(JSON.parse(text.text)).toMatchObject(connected ? { status } : { status: 'unavailable', reason: 'noClient' });
          if (connected) expect(admitted.at(-1)).toMatchObject({ actionId, context: { surface: 'mcp', authority: 'account_automation' } });
        }
        return;
      }
      for (const [actionId, input, connectedResult, absentResult] of [
        ['ui.find', { op: 'read' }, { status: 'idle' }, { status: 'unavailable', reason: 'noClient' }],
        ['session.pending.next', {}, { status: 'none' }, { status: 'unavailable', reason: 'noClient' }],
        ['workspace.tabs.list', {}, workspace, { errorCode: 'unsupported_action', error: 'unsupported_action:workspace.tabs.list',
          requestId: expect.any(String) }],
      ] as const) {
        const response = CallToolResultSchema.parse(await client.callTool({ name: 'action_execute', arguments: { actionId, input } }));
        const text = response.content.find(entry => entry.type === 'text');
        if (!text || text.type !== 'text') throw new Error('Missing MCP text result');
        expect(JSON.parse(text.text)).toEqual(connected ? connectedResult : absentResult);
      }
      expect(admitted).toHaveLength(connected ? 3 : 0);
      const dashboard = CallToolResultSchema.parse(await client.callTool({ name: 'action_execute', arguments: {
        actionId: 'widgets.area.layout.select', input: dashboardInput,
      } }));
      const dashboardText = dashboard.content.find(entry => entry.type === 'text');
      if (!dashboardText || dashboardText.type !== 'text') throw new Error('Missing dashboard result');
      expect(JSON.parse(dashboardText.text)).toEqual(connected ? dashboardResult : {
        errorCode: 'unavailable', error: 'noClient', requestId: expect.any(String),
      });
      const ref = { surface: { serverId: configuration.activeServerId, accountId: 'viewer',
        owner: { kind: 'companion', sessionId: 'mcp-session-active' } }, instanceId: 'checks' };
      const companion = CallToolResultSchema.parse(await client.callTool({ name: 'action_execute', arguments: {
        actionId: 'widgets.item.inputs.get', input: { ref },
      } }));
      const companionText = companion.content.find(entry => entry.type === 'text');
      if (!companionText || companionText.type !== 'text') throw new Error('Missing Companion result');
      expect(JSON.parse(companionText.text)).toMatchObject(connected ? { ref, bindings: {} } : { errorCode: 'unavailable' });
      if (connected) expect(admitted.at(-1)).toMatchObject({ actionId: 'widgets.item.inputs.get', context: { defaultSessionId: 'mcp-session-active' } });
      if (connected) for (const request of admitted) expect(request).toMatchObject({ context: {
        surface: 'mcp', authority: 'account_automation', defaultSessionId: 'mcp-session-active', defaultSessionMachineId: 'mcp-machine',
      } });
      const approval = CallToolResultSchema.parse(await client.callTool({ name: 'action_execute', arguments: {
        actionId: 'session.draft.delete', input: { draftId: '11111111-1111-4111-8111-111111111111' },
      } }));
      const approvalText = approval.content.find(entry => entry.type === 'text');
      if (!approvalText || approvalText.type !== 'text') throw new Error('Missing approval refusal');
      expect(JSON.parse(approvalText.text)).toMatchObject({ errorCode: 'approvals_not_supported' });
      expect(daemonAdmissions).toContainEqual(expect.objectContaining({ actionId: 'session.draft.delete', surface: 'mcp' }));
      // A refused draft deletion never reaches the mounted effect owner.
      expect(admitted.filter(raw => UiActionDispatchRequestV1Schema.parse(raw).actionId === 'session.draft.delete')).toEqual([]);

      const dismissCoach = async () => {
        const response = CallToolResultSchema.parse(await client.callTool({ name: 'action_execute', arguments: { actionId: 'usage.coach.dismiss', input: coachInput } }));
        const text = response.content.find(entry => entry.type === 'text');
        if (!text || text.type !== 'text') throw new Error('Missing Coach dismissal result');
        return JSON.parse(text.text) as unknown;
      };
      // Coach dismiss is a safe preference edit. It preserves the MCP principal
      // without requiring an approval waiver (the canonical Coach declaration).
      const noWaiverResult = await dismissCoach();
      const coachAdmissionsBeforeWaiver = admitted.filter(raw => UiActionDispatchRequestV1Schema.parse(raw).actionId === 'usage.coach.dismiss');
      reviewedSettings = waivedSettings;
      // REPLAY-C: an exact client on Usage can answer workspace controls even
      // though the invoking Agent's Session room is no longer mounted.
      const opened = CallToolResultSchema.parse(await client.callTool({ name: 'action_execute', arguments: {
        actionId: 'workspace.tabs.open', input: { href: '/settings/notifications', mode: 'newTab',
          reuseExisting: false, clientId: 'usage-app' },
      } }));
      const openedText = opened.content.find(entry => entry.type === 'text');
      if (!openedText || openedText.type !== 'text') throw new Error('Missing workspace tab result');
      expect(JSON.parse(openedText.text)).toEqual(connected ? workspaceOpened : {
        errorCode: 'client_not_available', error: 'The selected clientId is not eligible or is disconnected',
        requestId: expect.any(String),
      });
      if (connected) expect(admitted.at(-1)).toMatchObject({ actionId: 'workspace.tabs.open', context: {
        surface: 'mcp', defaultSessionId: 'mcp-session-active',
      } });
      const homeLookupsBeforeCoach = homeSessionLookups.length;
      const dismissed = await dismissCoach();
      // Without a client, the canonical Coach owner needs its preference port.
      // This relay-only fixture supplies none, so it refuses the edit.
      const absentCoachOwner = {
        errorCode: 'coach_preferences_unavailable', error: 'coach_preferences_unavailable', requestId: expect.any(String),
      };
      expect.soft(dismissed).toEqual(connected ? coachResult : absentCoachOwner);
      expect.soft(noWaiverResult).toEqual(connected ? coachResult : absentCoachOwner);
      expect(coachAdmissionsBeforeWaiver).toHaveLength(connected ? 1 : 0);
      expect(daemonAdmissions).toContainEqual(expect.objectContaining({
        actionId: 'usage.coach.dismiss', surface: 'mcp', target: { kind: 'session', sessionId: 'mcp-session-active' },
      }));
      expect(homeSessionLookups.slice(homeLookupsBeforeCoach)).toContain('/v2/sessions/mcp-session-active');
      const coachAdmissions = admitted.filter(raw => UiActionDispatchRequestV1Schema.parse(raw).actionId === 'usage.coach.dismiss');
      expect(coachAdmissions).toHaveLength(connected ? 2 : 0);
      if (connected) {
        const request = UiActionDispatchRequestV1Schema.parse(coachAdmissions[0]);
        expect(request).toMatchObject({ input: { evidenceKey: coachInput.evidenceKey, dismissed: true }, context: {
          surface: 'mcp', authority: 'account_automation', actionCaller: { kind: 'host' },
          defaultSessionId: 'mcp-session-active', defaultSessionMachineId: 'mcp-machine',
          externalActionTarget: { kind: 'session', sessionId: 'mcp-session-active' },
        } });
        expect(getUsageQueryKey(UsageCoachDismissInputSchema.parse(request.input).query)).toBe(getUsageQueryKey(coachQuery));
      }
      if (connected) {
        const selected = CallToolResultSchema.parse(await client.callTool({ name: 'action_execute', arguments: { actionId: 'session.target.primary.set', input: {
          sessionId: 'requested-session', serverId: configuration.activeServerId,
        } } }));
        expect(selected.isError).not.toBe(true);
        expect(admitted.at(-1)).toMatchObject({ actionId: 'session.target.primary.set', context: { defaultSessionId: 'requested-session' } });
        await client.callTool({ name: 'action_execute', arguments: { actionId: 'ui.find', input: { op: 'read' } } });
        expect(admitted.at(-1)).toMatchObject({ actionId: 'ui.find', context: { defaultSessionId: 'canonical-session' } });
        primarySessionId = 'foreign-session';
        primaryServerId = 'srv_foreign';
        await client.callTool({ name: 'action_execute', arguments: { actionId: 'session.target.primary.set', input: {
          sessionId: 'foreign-session', serverId: configuration.activeServerId,
        } } });
        await client.callTool({ name: 'action_execute', arguments: { actionId: 'ui.find', input: { op: 'read' } } });
        expect(admitted.at(-1)).toMatchObject({ actionId: 'ui.find', context: { defaultSessionId: 'canonical-session' } });
        primarySessionId = 'canonical-session';
        primaryServerId = portableHomeId;
        clientAvailable = false;
        await client.callTool({ name: 'action_execute', arguments: { actionId: 'session.target.primary.set', input: {
          sessionId: 'unaccepted-session', serverId: configuration.activeServerId,
        } } });
        clientAvailable = true;
        await client.callTool({ name: 'action_execute', arguments: { actionId: 'ui.find', input: { op: 'read' } } });
        expect(admitted.at(-1)).toMatchObject({ actionId: 'ui.find', context: { defaultSessionId: 'canonical-session' } });
        primarySessionId = null;
        await client.callTool({ name: 'action_execute', arguments: { actionId: 'session.target.primary.set', input: { sessionId: null } } });
        expect(admitted.at(-1)).toMatchObject({ actionId: 'session.target.primary.set' });
        expect(UiActionDispatchRequestV1Schema.parse(admitted.at(-1)).context).not.toHaveProperty('defaultSessionId');
        await client.callTool({ name: 'action_execute', arguments: { actionId: 'ui.find', input: { op: 'read' } } });
        expect(UiActionDispatchRequestV1Schema.parse(admitted.at(-1)).context).not.toHaveProperty('defaultSessionId');
      }
    } finally {
      await client.close(); await mcp.close(); await app.close();
      await runtime?.dispose();
      home.closeAllConnections();
      await new Promise<void>(resolve => home.close(() => resolve()));
    }
  });

  it.each([
    { actionId: 'ui.find', input: { op: 'read' } },
    { actionId: 'registries.sources.list', input: { kind: 'app' } },
  ])('preserves daemon_unavailable for $actionId when the captured Home has no daemon', async ({ actionId, input }) => {
    const { mcp } = createExternalMcpServer({ credentials, daemonControlTarget: null });
    const client = new Client({ name: 'absent-daemon-test', version: '1' });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await mcp.connect(serverTransport); await client.connect(clientTransport);
    try {
      const response = CallToolResultSchema.parse(await client.callTool({ name: 'action_execute', arguments: { actionId, input } }));
      const text = response.content.find(entry => entry.type === 'text');
      if (!text || text.type !== 'text') throw new Error('Missing MCP text result');
      expect(JSON.parse(text.text)).toEqual({ errorCode: 'daemon_unavailable', error: 'daemon_unavailable' });
      expect(response.isError).toBe(true);
    } finally { await client.close(); await mcp.close(); }
  });

  it.each([
    { actionId: 'ui.find', input: { op: 'read' } },
    { actionId: 'registries.sources.list', input: { kind: 'app' } },
  ])('preserves daemon_unavailable for $actionId when the captured daemon request fails', async ({ actionId, input }) => {
    const requests: string[] = [];
    const daemon = createServer((request, response) => {
      request.resume();
      requests.push(request.url ?? '');
      response.statusCode = 503;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ errorCode: 'daemon_unavailable', error: 'daemon_unavailable' }));
    });
    daemon.listen(0, '127.0.0.1');
    await once(daemon, 'listening');
    const address = daemon.address();
    if (!address || typeof address === 'string') throw new Error('Missing daemon address');
    const { mcp } = createExternalMcpServer({
      credentials,
      daemonControlTarget: { pid: process.pid, httpPort: address.port, controlToken: 'request-failure-control' },
    });
    const client = new Client({ name: 'failed-daemon-request-test', version: '1' });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await mcp.connect(serverTransport); await client.connect(clientTransport);
    try {
      const response = CallToolResultSchema.parse(await client.callTool({ name: 'action_execute', arguments: { actionId, input } }));
      const text = response.content.find(entry => entry.type === 'text');
      if (!text || text.type !== 'text') throw new Error('Missing MCP text result');
      expect(JSON.parse(text.text)).toEqual({ errorCode: 'daemon_unavailable', error: 'daemon_unavailable' });
      expect(requests).toEqual(['/actions/root/execute']);
    } finally {
      await client.close(); await mcp.close();
      daemon.closeAllConnections();
      await new Promise<void>(resolve => daemon.close(() => resolve()));
    }
  });

  it('delivers Project readiness to the same captured daemon as Machine setup', async () => {
    const deliveries: ReturnType<typeof SignedRootActionExecuteRequestSchema.parse>[] = [];
    // Only the remote daemon's HTTP boundary is replaced. MCP registration,
    // placement, host construction and control transport remain real.
    const daemon = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      deliveries.push(SignedRootActionExecuteRequestSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ ok: false, errorCode: 'source_unavailable', error: 'source_unavailable',
        details: { phase: 'readiness.source' } }));
    });
    daemon.listen(0, '127.0.0.1'); await once(daemon, 'listening');
    const address = daemon.address();
    if (!address || typeof address === 'string') throw new Error('Missing daemon address');
    vi.stubEnv('HAPPIER_ACTIONS_SETTINGS_V1', JSON.stringify(normalizeActionsSettingsV1({ v: 1 })));
    const { mcp } = createExternalMcpServer({ credentials, machineId: 'controller',
      daemonControlTarget: { pid: process.pid, httpPort: address.port, controlToken: 'readiness-control' } });
    const client = new Client({ name: 'standalone-readiness', version: '1' });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    try {
      await mcp.connect(serverTransport); await client.connect(clientTransport);
      for (const invocation of [
        { actionId: 'machines.setup.plan', input: { homeId: 'home', machineId: 'controller' } },
        { actionId: 'projects.readiness.read', input: { serverId: configuration.activeServerId, machineId: 'controller',
          projectId: 'project', environments: [{ environmentId: 'production', expectedRevision: 2 }] } },
      ] as const) {
        const input = getActionSpec(invocation.actionId).inputSchema.parse(invocation.input);
        const response = CallToolResultSchema.parse(await client.callTool({ name: 'action_execute',
          arguments: { actionId: invocation.actionId, input } }));
        const content = response.content.find(entry => entry.type === 'text');
        if (!content || content.type !== 'text') throw new Error('Missing MCP text result');
        expect(JSON.parse(content.text), invocation.actionId).toMatchObject({ errorCode: 'source_unavailable',
          details: { phase: 'readiness.source' } });
        expect(deliveries.at(-1)).toMatchObject({ actionId: invocation.actionId, input, surface: 'mcp',
          target: { kind: 'machine', machineId: 'controller' } });
      }
    } finally {
      await client.close(); await mcp.close(); daemon.closeAllConnections();
      await new Promise<void>(resolve => daemon.close(() => resolve()));
    }
  });
});
