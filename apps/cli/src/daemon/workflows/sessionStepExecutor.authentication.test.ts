import axios from 'axios';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { ConnectedAccountCatalogRowReadResponseV1Schema } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import { HomeSessionDefaultsProjectionV1Schema } from '@happier-dev/protocol/home/governance/projection';
import * as persistence from '@/persistence';
import * as machineRpc from '@/session/transport/rpc/machineRpc';
import { createAccountEncryptionCurrentnessFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { resolveQualifiedPurposeDeclarationSnapshotForAgentSpawn } from '@/daemon/connectedServices/requestAuth/prepareConnectedAccountRequestAuthForSpawn';
import { resetInMemoryAccountSettingsContextForTests } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createAdmittedFreshWorkflowSessionConversation as createProductionFreshWorkflowSessionConversation } from './workflowSessionStartup.testkit';
import { prepareSessionCreationTarget } from '@/session/creation/prepareSessionCreationTarget';
import { SessionCreationTargetPreparationRequestV1Schema } from '@happier-dev/protocol/sessions/creation/sessionCreationTargetPreparationV1';
import { buildCommittedLaunchMetadata } from '@/agent/runtime/createSessionMetadata';
import { SpawnDaemonSessionRequestSchema } from '@/rpc/handlers/spawnSessionOptionsContract';

let runtime: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>>;
beforeAll(async () => {
  runtime = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController, runtimeOptions: { pluginIds: [] } });
});
afterAll(async () => { await runtime?.dispose(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); resetInMemoryAccountSettingsContextForTests(); });

it.each(['profile', 'group', 'override', 'native', 'explicit_native'] as const)(
  'spawns Workflow Claude with the resolved %s authentication, not the native inventory state', async (authentication) => {
    const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: 'workflow-account' })).toString('base64url')}.signature`, encryption: null } as const;
    const serviceId = 'happier.agent.claude/claude-subscription';
    let birthMetadata: ReturnType<typeof buildCommittedLaunchMetadata> | undefined;
    const scope = resolveQualifiedPurposeDeclarationSnapshotForAgentSpawn({ agentId: 'claude',
      contributions: runtime.registry.contributes })?.authorizedPurposes.find(entry => entry.serviceRefs[0]?.localId === 'claude-subscription');
    if (!scope?.serviceRefs[0]) throw new Error('Real Claude purpose unavailable');
    vi.spyOn(persistence, 'readStoredCredentials').mockResolvedValue(credentials);
    // Only authenticated Home HTTP and daemon RPC are substituted. Defaulting,
    // target preparation, Session creation, nonce settlement and parsing stay real.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    vi.spyOn(axios, 'get').mockImplementation(async input => {
      const path = new URL(String(input)).pathname;
      if (path === '/v2/account/settings') return { status: 200, data: { version: 9, content: { t: 'plain', v: {} } } };
      if (path === '/v2/account/settings/history') return { status: 200, data: { snapshots: [] } };
      if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
      if (path === '/v1/account/entity-rows/connected-accounts/purposes') return { status: 200,
        data: ConnectedAccountCatalogRowReadResponseV1Schema.parse({ status: 'present', revision: 3,
          content: { t: 'plain', v: { key: 'purposes', value: { v: 1, bindings: authentication === 'native' ? [] : [{
            purpose: scope.purpose, target: authentication === 'group'
              ? { kind: 'group', service: scope.serviceRefs[0], groupId: 'claude-pool' }
              : { kind: 'account', account: { service: scope.serviceRefs[0], accountId: 'claude-default' } },
          }] } } } }) };
      if (path === '/v2/sessions/connected-child') return { status: 200, data: { session: createSessionRecordFixture({
        id: 'connected-child', encryptionMode: 'plain', metadata: JSON.stringify({ path: process.cwd(), host: 'fixture', ...birthMetadata }),
      }) } };
      return { status: 404, data: { error: 'unsupported' } };
    });
    vi.spyOn(axios, 'post').mockImplementation(async input => {
      if (new URL(String(input)).pathname === '/v2/sessions/lookup-by-tags') return { status: 200, data: { sessions: [] } };
      throw new Error('Unexpected Home mutation');
    });
    vi.spyOn(axios, 'request').mockImplementation(async ({ url }) => {
      if (new URL(String(url)).pathname === '/v1/home/governance/get') return { status: 200,
        data: HomeSessionDefaultsProjectionV1Schema.parse({ homeDefaults: null }) };
      throw new Error('Unexpected Home Action');
    });
    const admitted: unknown[] = [];
    const machineBoundary: typeof machineRpc.callExactMachineRpc = async ({ method, request }) => {
      if (method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) {
        return { protocolVersion: 1, projection: { v: 2, generation: 1, familiesById: {}, agentsById: {
          claude: { id: 'claude', title: 'Claude', capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } } },
        } } };
      }
      if (method === RPC_METHODS.CAPABILITIES_DETECT) return { protocolVersion: 1, results: { 'cli.claude': {
        ok: true, checkedAt: 1, data: { installed: true, version: null, latestVersion: null,
          update: { supported: false, command: null }, signIn: { status: 'signedIn', loginSupport: 'unsupported' },
          platform: { supported: true }, install: { available: false, mode: 'none', sizeBytes: null, guideUrl: null }, dependencies: [] },
      } } };
      if (method === RPC_METHODS.DAEMON_SESSION_CREATION_DIRECTORY_PREFLIGHT) return prepareSessionCreationTarget({
        request: SessionCreationTargetPreparationRequestV1Schema.parse(request) });
      if (method !== RPC_METHODS.SPAWN_HAPPY_SESSION) throw new Error('Unexpected Machine method');
      admitted.push(request);
      birthMetadata = buildCommittedLaunchMetadata({ options: SpawnDaemonSessionRequestSchema.parse(request),
        directory: process.cwd(), accountSettings: {} });
      // This Machine has no native credentials. Connected profile/pool
      // materialization is the only authentication accepted by its OS boundary.
      if (authentication === 'native' || authentication === 'explicit_native') return {
        type: 'error', errorCode: 'agent_signed_out', errorMessage: 'Native auth missing', agentId: 'claude',
      };
      return { type: 'success', sessionId: 'connected-child', sessionCreationOutcome: {
        disposition: 'created', organizationPlacement: { folderId: null, tagIds: [] },
      } };
    };
    vi.spyOn(machineRpc, 'callExactMachineRpc').mockImplementation(machineBoundary);
    vi.spyOn(machineRpc, 'callMachineRpc').mockImplementation(machineBoundary);
    const create = createProductionFreshWorkflowSessionConversation({ credentials, serverId: 'server-1', machineId: 'machine-1',
      workDepth: 0, originRunId: 'workflow-run', machineAdmissionTransport: async () => ({ status: 'accepted', localId: 'unused' }),
    });
    const result = runWithServerHttpBaseUrl('https://workflow-home.example', () => create({
      selection: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
        ...(authentication === 'override' ? { connectedServices: { v: 2, bindingsByServiceId: {
          [serviceId]: { source: 'connected', selection: 'profile', profileId: 'step-override' },
        } } } : authentication === 'explicit_native' ? { connectedServices: null } : {}),
      },
      workspace: { machineId: 'machine-1', directory: process.cwd(), checkoutRootPath: process.cwd() },
      creationKey: `workflow:auth:${authentication}`,
    }));
    if (authentication === 'native' || authentication === 'explicit_native') {
      await expect(result).rejects.toMatchObject({ code: 'agent_signed_out' });
      expect(admitted).toEqual([expect.objectContaining({ connectedServices: { v: 2, bindingsByServiceId: {} } })]);
    } else {
      await expect(result).resolves.toMatchObject({ sessionId: 'connected-child' });
      expect(admitted).toEqual([expect.objectContaining({ connectedServices: { v: 2, bindingsByServiceId: expect.objectContaining({
        [serviceId]: authentication === 'group' ? { source: 'connected', selection: 'group', groupId: 'claude-pool' }
          : { source: 'connected', selection: 'profile', profileId: authentication === 'override' ? 'step-override' : 'claude-default' },
      }) } })]);
    }
  },
);
