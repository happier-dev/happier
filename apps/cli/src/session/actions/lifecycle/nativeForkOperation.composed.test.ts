import axios from 'axios';
import { AccountSettingsV2GetResponseSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildSessionWorkspaceLocationV1 } from '@happier-dev/protocol/sessions/metadata/sessionWorkspaceLocationV1';

import * as persistence from '@/persistence';
import { buildSessionMetadataEnvelopeCreateFields } from '@/session/metadata/buildSessionMetadataEnvelopeCreateFields';
import { sealSessionStoredContent } from '@/session/transport/encryption/sessionStoredContentCodec';
import { createReplayMessagesPage } from '@/session/replay/replayMessagesFixture.testkit';
import { createAccountEncryptionCurrentnessFixture, createCurrentSessionProjectionRecordFixture, createSessionNotificationContextFixture } from '@/testkit/backends/sessionFixtures';
import { registerSessionLifecycleRpcHandlers } from '@/rpc/handlers/sessionLifecycle';
import { createRpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { authorizeMachineRpcRequest } from '@/api/machine/machineRpcAuthorization';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createMachineSessionLifecycleActionExecutor } from '@/session/actions/sessionLifecycleActions';
import { computeActionInputApprovalDigestV1 } from '@happier-dev/protocol/actions/decisionAuthority';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createCliActionDeps } from '@/session/actions/createCliActionDeps';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { projectCurrentAgentSessionView } from '@happier-dev/agents';

const machineRpc = vi.hoisted(() => vi.fn());
// Only the serialized network hop is substituted; its receiving RPC, operation
// owner and native lifecycle stay real. Private acceptance cannot cross this hop.
vi.mock('@/session/transport/rpc/machineRpc', () => ({ callMachineRpc: machineRpc, callExactMachineRpc: machineRpc }));

let runtimeHome = '';
beforeAll(async () => {
  runtimeHome = await createTempDir('happier-fork-workspace-');
  const registry = await resolveExecutablePluginRuntimeRegistry({ happyHomeDir: runtimeHome,
    resolveDevelopmentSourceAuthority: ({ pluginId, rootPath }) => ({ kind: 'development',
      registeredRootId: `fork-workspace:${pluginId}`, canonicalRoot: rootPath, observedRevision: 1 }),
  });
  const result = await pluginReloadController.adoptPreparedRuntimeRegistry({ registry,
    changedPluginIds: ['happier.agent.claude'], durableRevision: 1, runningSessionDisposition: 'retainRunningSessions' });
  expect(result.ok).toBe(true);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); machineRpc.mockReset(); });
afterAll(async () => {
  await pluginReloadController.shutdown();
  if (runtimeHome) await removeTempDir(runtimeHome);
});

describe('admitted native fork', () => {
  it('returns the native fork owner outcome without observing normalized input as a second request', async () => {
    const mode = 'plain';
    const secret = new Uint8Array(32).fill(9);
    const credentials: persistence.StoredCredentials = { token: 'fixture-token',
      encryption: null };
    const parentSessionId = 'c1234567890123456789012345';
    const machineId = 'machine-1';
    const fields = buildSessionMetadataEnvelopeCreateFields({ credentials, accountEncryptionMode: mode,
      metadata: { path: '/host/project', host: 'fixture-host', machineId, flavor: 'claude',
        ...projectCurrentAgentSessionView({
          runtimeDescriptorV1: { v: 1, agentId: 'claude', agent: { providerSessionId: 'provider-parent' } },
        }, { agentId: 'claude', runtimeDescriptor: { v: 1, agentId: 'claude', agent: { providerSessionId: 'provider-parent' } },
          nativeResumeIdentity: { v: 1, vendorResumeId: 'provider-parent' } }),
        sessionWorkspaceLocationV1: buildSessionWorkspaceLocationV1({ machineId,
          agentPath: '/agent/project', machinePath: '/host/project' }) }, agentState: null,
      storedContentMode: 'plain',
    });
    const parent = createCurrentSessionProjectionRecordFixture({
      ...createSessionNotificationContextFixture(parentSessionId), seq: 1, encryptionMode: mode,
      metadataLayoutVersion: fields.metadataLayoutVersion, metadata: fields.sharedMetadata.ciphertext,
      ownerMetadata: fields.ownerMetadata, agentState: fields.agentState,
    });
    const messages = createReplayMessagesPage({ hasMore: false, messages: [{ seq: 1, createdAt: 1,
      content: sealSessionStoredContent({ mode: 'plain', ctx: null,
        payload: { role: 'user', content: { type: 'text', text: 'Continue the workspace task' } } }),
    }] });
    const unexpectedRequests: string[] = [];
    // Authentication/persistence and HTTP are system boundaries. RPC dispatch,
    // owner-envelope opening and Agent fork resolution stay real.
    vi.spyOn(persistence, 'readStoredCredentials').mockResolvedValue(credentials);
    vi.stubGlobal('fetch', vi.fn(async value => {
      const url = String(value);
      if (url.endsWith('/v1/features')) return Response.json({ features: {}, capabilities: {
        encryption: { storagePolicy: 'optional', allowAccountOptOut: true, defaultAccountMode: mode },
      } });
      if (url.endsWith('/v1/account/profile')) return Response.json({ id: 'fixture-account' });
      unexpectedRequests.push(url);
      return Response.json({}, { status: 404 });
    }));
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      if (path === `/v2/sessions/${parentSessionId}`) return { status: 200, data: { session: parent } };
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: createAccountEncryptionCurrentnessFixture({ mode }) };
      if (path === `/v1/sessions/${parentSessionId}/messages`) return { status: 200, data: messages };
      if (path === '/v2/account/settings') return { status: 200,
        data: AccountSettingsV2GetResponseSchema.parse({ content: null, version: 0 }) };
      unexpectedRequests.push(path);
      return { status: 404, data: {} };
    });
    const machineHandlers = {
      spawnSession: async () => { throw new Error('Unsupported native forks must not spawn'); },
      stopSession: async () => { throw new Error('Replay must not stop its parent'); },
      requestShutdown: () => undefined,
    };
    const manager = createRpcHandlerManager({ scopePrefix: machineId, scopeKind: 'machine', localMachineId: machineId,
      encryptionKey: secret, encryptionVariant: 'legacy', encryptionMode: 'plain',
      authorizeRequest: request => authorizeMachineRpcRequest(request, {
        machineId, resolveCustodianAccountId: async () => 'fixture-account',
        resolveInstallationId: () => 'installation', resolveHomeServerIdentityId: async () => 'home',
        // The installed identity and authenticated Home verification are system boundaries.
        verifyMachineAdmission: async () => true,
      }),
    });
    machineRpc.mockImplementation(async ({ method, request }) => manager.invokeLocal(method, request,
      { rpcContext: { machineAdmission: { actorAccountId: 'fixture-account', custodianAccountId: 'fixture-account',
        machineId, installationId: 'installation', role: 'manage', encryptionMode: 'plain' }, callerAuthority: 'present_user' } }));
    const operations = createHostActionOperationRuntime({ machineId, resolveAccountId: async () => 'fixture-account' });
    registerSessionLifecycleRpcHandlers({
      rpcHandlerManager: manager,
      observeExecution: operations.observeExecution,
      actionExecutor: createMachineSessionLifecycleActionExecutor({
        handlers: machineHandlers,
        deps: { currentMachineId: machineId },
      }), actionIds: ['session.fork'],
    });
    const actionInput = { sessionId: parentSessionId, serverId: 'home', strategy: 'native', forkPoint: { type: 'latest' } };
    const target = { kind: 'session' as const, sessionId: parentSessionId };
    const admission = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-admitted', binding: {
      accountId: 'fixture-account', custodianAccountId: 'fixture-account', authentication: { kind: 'account', tokenEpoch: 0 },
      accountEncryptionMode: 'plain', serverIdentityId: 'home', actionId: 'session.fork', requestId: 'native-fork-request',
      machineId, installationId: 'installation', target, requestEnvelopeDigest: 'a'.repeat(43),
    } });
    const executor = createActionExecutor(createCliActionDeps({ token: credentials.token, credentials,
      sessionId: parentSessionId, mode: 'plain', ctx: null, serverId: 'home', serverIdentityId: 'home',
      externalActionMachineInstallationId: 'installation', externalActionMachineRequestPrivateKey: new Uint8Array(32),
      actionsSettingsProvider: createActionSettingsProvider({ accountSettings: accountSettingsParse({}) }),
      machineActionDirectTargetTransport: { machineId, invoke: (method, input, options) => manager.invokeLocal(method, input, options) },
    }));
    const response = await operations.runActionOperation({ actionId: 'session.fork', input: actionInput,
      context: { surface: 'cli', authority: 'present_user', actionRequestId: 'native-fork-request', defaultSessionId: parentSessionId,
        runtimeAccountId: 'fixture-account', serverId: 'home', serverIdentityId: 'home',
        actionCaller: { kind: 'host' },
        presentUserConfirmation: { actionId: 'session.fork', requestId: 'native-fork-request', accountId: 'fixture-account',
          serverId: 'home', inputDigest: computeActionInputApprovalDigestV1('session.fork', actionInput), target },
        machineAdmission: { actorAccountId: 'fixture-account', custodianAccountId: 'fixture-account', machineId,
          installationId: 'installation', role: 'manage', encryptionMode: 'plain' },
        externalActionExecutionAuthorization: admission, externalActionTarget: target },
      execute: context => executor.execute('session.fork', actionInput, context) });
    // Claude's current native-fork capability is unsupported. The native owner
    // must decide that; a second observation must not replace it with a conflict.
    expect(response).toEqual({ ok: false, errorCode: 'INVALID_REQUEST', error: 'Requested fork strategy is not supported' });
    expect(unexpectedRequests).toEqual([]);
  });
});
