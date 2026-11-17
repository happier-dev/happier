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
import { openSessionOwnerMetadataEnvelopeV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataEnvelopesV1';
import { bindApprovalProfileV1 } from '@happier-dev/protocol/actions/approvalProfileArtifactV1';
import { ApprovalProfileV1Schema } from '@happier-dev/protocol/actions/approvalProfiles';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { resolveActionApprovalRouting } from '@happier-dev/protocol/actions/actionApprovalPolicy';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { AUTOMATION_ACTION_INDEX_HTTP_PATH_V1, ActionAutomationIndexV1Schema } from '@happier-dev/protocol/automations/automationActionTriggerV1';

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

describe('approval profile provenance through Session lifecycle Actions', () => {
  it.each([
    { family: 'fork', selection: 'omitted' }, { family: 'fork', selection: 'same' }, { family: 'fork', selection: 'none' },
  ] as ReadonlyArray<{ family: 'fork' | 'continue'; selection: 'omitted' | 'same' | 'none' }>)('keeps inherited policy stricter until an explicit same-id pick ($family, selection=$selection)', async ({ family, selection }) => {
    const actionId = family === 'fork' ? 'session.fork' : 'session.continue_with_replay';
    const profileId = 'shared-profile';
    const policyActionId = 'daemon.filesystem.readFile';
    const accountPolicy = normalizeActionsSettingsV1({ v: 1,
      actions: { [policyActionId]: { approvalRequiredSurfaces: ['agent'] } } });
    const profile = ApprovalProfileV1Schema.parse({ id: profileId, name: 'Allowed reads',
      actions: { [policyActionId]: { enabled: true } }, approvalWaivedSurfaces: { [policyActionId]: ['agent'] } });
    const boundProfile = bindApprovalProfileV1([{ id: profileId, profile, access: 'view',
      revision: { headerVersion: 1, bodyVersion: 1 } }], profileId);
    const mode = 'plain';
    const secret = new Uint8Array(32).fill(9);
    const credentials: persistence.StoredCredentials = { token: 'fixture-token',
      encryption: null };
    const parentSessionId = 'c1234567890123456789012345';
    const machineId = 'machine-1';
    const fields = buildSessionMetadataEnvelopeCreateFields({ credentials, accountEncryptionMode: mode,
      metadata: { path: '/host/project', host: 'fixture-host', machineId, flavor: 'claude',
        approvalProfileId: profileId, approvalProfileTeamOrGroupDerived: true,
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
    let createdOwnerMetadata: unknown;
    const unexpectedRequests: string[] = [];
    // Authentication/persistence and HTTP are system boundaries. RPC dispatch,
    // owner-envelope opening and Agent fork resolution stay real.
    vi.spyOn(persistence, 'readStoredCredentials').mockResolvedValue(credentials);
    vi.spyOn(persistence, 'readSettings').mockResolvedValue({ schemaVersion: persistence.SUPPORTED_SCHEMA_VERSION,
      onboardingCompleted: true, machineId });
    vi.stubGlobal('fetch', vi.fn(async value => {
      const url = String(value);
      if (url.endsWith('/v1/features')) return Response.json({ features: {}, capabilities: {
        encryption: { storagePolicy: 'optional', allowAccountOptOut: true, defaultAccountMode: mode },
      } });
      if (url.endsWith('/v1/account/profile')) return Response.json({ id: 'fixture-account' });
      if (url.endsWith(AUTOMATION_ACTION_INDEX_HTTP_PATH_V1)) return Response.json(ActionAutomationIndexV1Schema.parse({ v: 1, rows: [] }));
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
    vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/sessions') {
        createdOwnerMetadata = body && typeof body === 'object' ? Reflect.get(body, 'ownerMetadata') : undefined;
        // Stop at the Home creation boundary; no daemon or Agent process is launched.
        return { status: 503, data: {} };
      }
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
      }), actionIds: [actionId],
    });
    const profileSelection = selection === 'omitted' ? {} : { approvalProfileId: selection === 'same' ? profileId : null };
    const actionInput = family === 'fork'
      ? { sessionId: parentSessionId, serverId: 'home', strategy: 'replay', forkPoint: { type: 'latest' }, ...profileSelection }
      : { directory: '/host/project', backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
        replay: { previousSessionId: parentSessionId }, ...profileSelection };
    const target = { kind: 'session' as const, sessionId: parentSessionId };
    const admission = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-admitted', binding: {
      accountId: 'fixture-account', custodianAccountId: 'fixture-account', authentication: { kind: 'account', tokenEpoch: 0 },
      accountEncryptionMode: 'plain', serverIdentityId: 'home', actionId, requestId: 'native-fork-request',
      machineId, installationId: 'installation', target, requestEnvelopeDigest: 'a'.repeat(43),
    } });
    const executor = createActionExecutor(createCliActionDeps({ token: credentials.token, credentials,
      sessionId: parentSessionId, mode: 'plain', ctx: null, serverId: 'home', serverIdentityId: 'home',
      externalActionMachineInstallationId: 'installation', externalActionMachineRequestPrivateKey: new Uint8Array(32),
      actionsSettingsProvider: createActionSettingsProvider({ accountSettings: accountSettingsParse({ actionsSettingsV1: accountPolicy }) }),
      machineActionDirectTargetTransport: { machineId, invoke: (method, input, options) => manager.invokeLocal(method, input, options) },
    }));
    const response = await operations.runActionOperation({ actionId, input: actionInput,
      context: { surface: family === 'continue' ? 'rpc' : 'cli', authority: 'present_user', approvalProfileId: profileId,
        approvalProfileTeamOrGroupDerived: true, approvalProfile: boundProfile, actionRequestId: 'native-fork-request', defaultSessionId: parentSessionId,
        runtimeAccountId: 'fixture-account', serverId: 'home', serverIdentityId: 'home',
        actionCaller: { kind: 'host' },
        presentUserConfirmation: { actionId, requestId: 'native-fork-request', accountId: 'fixture-account',
          serverId: 'home', inputDigest: computeActionInputApprovalDigestV1(actionId, actionInput), target },
        machineAdmission: { actorAccountId: 'fixture-account', custodianAccountId: 'fixture-account', machineId,
          installationId: 'installation', role: 'manage', encryptionMode: 'plain' },
        externalActionExecutionAuthorization: admission, externalActionTarget: target },
      execute: context => executor.execute(actionId, actionInput, context) });
    expect(response).toMatchObject({ ok: false });
    expect(createdOwnerMetadata, JSON.stringify({ response, unexpectedRequests })).toBeDefined();
    const opened = openSessionOwnerMetadataEnvelopeV1({ accountMode: 'plain', envelope: createdOwnerMetadata });
    expect(opened).toMatchObject({ ok: true });
    if (!opened.ok) throw new Error(opened.reason);
    const routing = resolveActionApprovalRouting({ actionId: policyActionId, spec: getActionSpec(policyActionId),
      settings: accountPolicy, context: { surface: 'agent', authority: 'account_automation',
        approvalProfileId: opened.ownerMetadata.runtime.approvalProfileId,
        approvalProfileTeamOrGroupDerived: opened.ownerMetadata.runtime.approvalProfileTeamOrGroupDerived,
        approvalProfile: selection === 'none' ? null : boundProfile } });
    expect(routing.required).toBe(selection !== 'same');
    expect(opened.ownerMetadata.runtime).toMatchObject({ approvalProfileId: selection === 'none' ? null : profileId,
      approvalProfileTeamOrGroupDerived: selection === 'omitted' });
    expect(unexpectedRequests).toEqual([]);
  });
});
