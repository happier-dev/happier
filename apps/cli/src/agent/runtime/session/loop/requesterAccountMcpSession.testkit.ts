import { ApiClient } from '@/api/api';
import { ApiSessionClient } from '@/api/session/sessionClient';
import { createMutableApiSessionClientFixture, createPlainSessionFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { startMcpRequesterParent } from '@/agent/runtime/session/loop/runHostSessionRuntime.mcpRequester.testkit';
import { bindRequesterSessionCredentialScope } from '@/persistence';
import { setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { FeaturesResponseSchema } from '@happier-dev/protocol';
import { ActionExecuteResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import type { StoredCredentials } from '@/persistence';
import type { ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller';
import type { ExecuteScmSourceReadAction } from '@/scm/hostingProviders/resolveRefForHost';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { vi, expect } from 'vitest';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';

/** Authored tool delivery is admitted by the same physical registry as GitHub. */
export const REQUESTER_ACCOUNT_MCP_AGENT_PLUGIN = {
  manifest: createPluginManifestV2Fixture({ id: 'com.example.requester-source-agent', contributes: { agents: [{
    id: 'reader', title: 'Source reader', primary: 'sessions', runtime: { kind: 'custom' },
    capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true },
      tools: { delivery: 'shell_bridge' } },
  }] } }),
  files: {
    'agent.mjs': "export function factory() { return { sessions: { open() { throw new Error('Session fixture supplies the vendor SDK'); } } }; }",
    'daemon.mjs': "import { factory } from './agent.mjs'; export function activate(api) { api.agents.register('reader', factory, { sessionRunnerFactory: { module: './agent.mjs', export: 'factory', runtimeApiVersion: 1 } }); }",
  },
};

/** Home transport and vendor SDK boundaries retain the actual Session host and MCP Action invocation. */
export async function startRequesterAccountMcpSession(input: Readonly<{
  credentials: StoredCredentials; snapshot: ActiveAccountSettingsSnapshot;
  serverId: string; serverHttpBaseUrl: string; accountId: string; machineId: string;
  installationId: string; sessionId: string; happyHomeDir: string;
  pluginRuntimeRegistryLease: PluginRuntimeRegistryLease;
}>) {
  const sessionId = input.sessionId;
  const sessionCredentials = bindRequesterSessionCredentialScope({ ...input.credentials }, {
    serverId: input.serverId, serverHttpBaseUrl: input.serverHttpBaseUrl,
    requesterSession: { sessionId,
      attribution: { serverId: input.serverId, accountId: input.accountId, machineId: input.machineId, installationId: input.installationId },
      machineAdmission: { custodianAccountId: input.accountId, role: 'manage' },
    },
  });
  const readySnapshot = { ...input.snapshot,
    promptLibraryCatalog: { status: 'ready' as const, rows: [], tombstones: [], diagnostics: [] },
    mcpServerCatalog: { status: 'ready' as const, authority: 'active' as const, revision: 1, diagnostics: [],
      catalog: { v: 1 as const, servers: [], bindings: [] } },
  };
  setActiveAccountSettingsSnapshot(readySnapshot);
  const session = createMutableApiSessionClientFixture({ sessionId,
    serverBinding: { serverId: input.serverId, serverUrl: input.serverHttpBaseUrl },
    metadata: createTestMetadata({ path: input.happyHomeDir, permissionMode: 'default',
      mcpSelectionV1: { v: 1, managedServersEnabled: false, forceIncludeServerIds: [], forceExcludeServerIds: [] } }),
    overrides: {
      bindSessionAttachmentNativeRuntime: ApiSessionClient.prototype.bindSessionAttachmentNativeRuntime,
      getServerFeaturesSnapshot: () => ({ status: 'ready', features: FeaturesResponseSchema.parse({
        features: { connectedServices: { enabled: true } },
        capabilities: { connectedServices: { qualifiedAccounts: { protocolVersion: 4 } } },
      }) }),
      getWorkDepth: () => 0, getHostTurnWorkDepth: () => 0,
      claimCurrentSessionPublisherAuthorityForStartup: async () => ({ status: 'claimed' }),
      activateDurableMutationDelivery: async () => undefined, deactivateDurableMutationDelivery: () => undefined,
      enqueueSessionTurnMutation: async () => undefined, enqueueRegisteredSessionStateFieldMutation: async () => undefined,
      enqueueSessionEventCommitted: async () => ({ persisted: true, delivered: false }),
      onUserMessage: () => undefined, hasPendingProviderInput: () => false,
      readPendingQueueStateForLiveWork: async () => ({ known: true, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 0 }),
      getPendingQueueState: () => ({ known: true, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 0 }),
      subscribeExecutionRunActivitySnapshots: () => () => undefined, setOwnerActivityDelivery: () => undefined,
      subscribeToSessionConnectionState: () => () => undefined,
      setSessionRuntimeControls: () => undefined, readRolePromptOrganization: async () => ({}),
    },
  });
  const api = await runWithServerHttpBaseUrl(input.serverHttpBaseUrl, () => ApiClient.create(sessionCredentials));
  // Session construction is the Home/socket boundary; keep the canonical offline transport.
  api.sessionSyncClient = () => session;
  const parent = await runWithServerHttpBaseUrl(input.serverHttpBaseUrl, () => startMcpRequesterParent({
    credentials: sessionCredentials, session, sessionRow: createPlainSessionFixture({ id: sessionId,
      metadata: session.getMetadataSnapshot()! }), nativeParentSelection: true, api, machineId: input.machineId, snapshot: readySnapshot,
    pluginRuntimeRegistryLease: input.pluginRuntimeRegistryLease,
    backendTarget: { kind: 'agent', identity: { pluginId: 'com.example.requester-source-agent', localId: 'reader' } },
    agentConfig: { flavor: 'source-reader', policyAgentId: 'com.example.requester-source-agent/reader',
      backendDisplayName: 'Source reader', providerName: 'Source reader', uiLogPrefix: '[Source reader]',
      waitingForCommandLabel: 'Source reader', agentMessageType: 'source-reader' },
  }));
  try {
    // The vendor turn is started through the real Session operation; this
    // credential test does not exercise Home Pending/prompt preparation. This
    // is the lifecycle.rollbackEligibility.test native-operation boundary.
    await parent.submitNativePrompt('Read the deployment source HEAD');
    // Native Session composed fixtures wait for the host-owned turn admission.
    await vi.waitFor(() => expect(parent.mcpSession.getActiveTurnAdmissionWitness?.(), 'Native host must admit the Source reader turn').toBeTruthy(), { timeout: 15_000 });
    expect(parent.readProviderInputs()).toHaveLength(1);
  } catch (error) { await parent.stop(); throw error; }
  const executeSourceReadAction: ExecuteScmSourceReadAction = async (action, actionInput) => {
    const result = await parent.mcpSession.rpcHandlerManager.invokeLocal(
      SESSION_RPC_METHODS.SESSION_AGENT_TOOL_CALL_V1, { toolName: 'action_execute', toolCallId: 'session-github-source-head',
        args: { actionId: 'action.invoke', input: { action, input: actionInput } } });
    const parsed = ActionExecuteResultSchema.safeParse(result);
    if (!parsed.success && result !== null && typeof result === 'object' && 'errorCode' in result) {
      throw new Error(`Session tool transport refused: ${String(result.errorCode)}`);
    }
    return ActionExecuteResultSchema.parse(result);
  };
  return { ...parent, executeSourceReadAction };
}
