import fastify from 'fastify';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { readBundledPluginAvailabilityHttpFixture } from '@/plugins/testkit/bundledPluginAvailabilityHttpFixture';
import { PluginAvailabilityActionHttpPathsV1 } from '@happier-dev/protocol/plugins/availability';
import { createCommittedContributedActionInvoker } from '@/plugins/runtime/invocation/actions/createCommittedContributedActionDeps';
import { createHostReviewedChildPortV1 } from '@happier-dev/protocol/actions/executor/deploymentRoleChild';
import { createPlatformFailureEnrollmentForHost } from '@/deployments/platformFailureEnrollment';
import { AccountProfileSchema, AutomationDefinitionCreateRequestSchema, AutomationDefinitionDetailSchema, AutomationDefinitionListResponseSchema, AutomationDefinitionReconcileRequestSchema,
  FeaturesResponseSchema, openAutomationTriggerDefinitionStoredEnvelopeV1, sealAutomationTriggerDefinitionStoredEnvelopeV1,
  type AutomationDefinitionDetail, type ActionExecutorContext } from '@happier-dev/protocol';
import { createDeploymentEnvironmentDetailV1, createDeploymentTargetLinkHeaderV1 } from '@happier-dev/deployments/testing/v1';
import { DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1 } from '@happier-dev/deployment-protocol';
import { encodePlainArtifactStoredContent } from '@happier-dev/protocol';
import { DEPLOYMENT_RECEIPT_EVENT_REFS_V1 } from '@happier-dev/plugin-sdk/events';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { registerAccountArtifactRoutes, registerAccountHomeHttp, registerPlainArtifactRoutes } from '@/session/actions/widgetApproval.testkit';
import { admitRequesterAccountActionContext, prepareInstalledRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import { createDaemonApprovalExecutionAuthorizationPreparer } from '@/daemon/externalActions/approvalExecutionAuthorization';
import { readOrCreateInstallationIdentity } from '@/daemon/identity/store';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { logger } from '@/ui/logger';
import { fetchServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { createRequesterBoundDeploymentActionDeps } from '@/daemon/externalActions/deploymentActionDeps';
import { createPluginRuntimeOccurrenceId } from '@/plugins/runtime/runtimeSlots';
import { projectExternalActionMachineRuntimeDemandV1 } from '@happier-dev/protocol/actions/actionSpecs';
import { createServer, type Server } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import * as fsPromises from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { deriveAccountMachineKeyFromRecoverySecret } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { openExternalActionRequestV2, prepareExternalActionResponseV2 } from '@happier-dev/protocol/actions/externalActionEncryption';
import { computeExternalActionRequestEnvelopeDigestV1, decodeExternalActionHttpBodyV1, EXTERNAL_ACTION_HTTP_BODY_HEADER_V1,
  verifyExternalActionMachineRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { deriveWorkspaceSyncRelationshipId, projectWorkspaceSyncAdmissionInputV1 } from '@happier-dev/protocol/workspaces/workspaceSyncAdmissionV1';
import { EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER, EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER, EXTERNAL_ACTION_HTTP_PATH_PREFIX_V1, ExternalActionExecutionAuthorizationVerifyRequestV1Schema, bindExternalActionExecutionAuthorizationHttpPathV1, bindExternalActionExecutionAuthorizationVerifyHttpPathV1, ExternalActionExecutionAuthorizationRequestV1Schema, projectExternalActionDeploymentPreparationEnvelopeAdmissionV1, type ExternalActionExecutionAuthorizationV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { ActionIdSchema, DeploymentPrepareInputV1Schema, ExternalActionRequestEnvelopeSchema, type ActionExecuteResult, type ActionId } from '@happier-dev/protocol';
import { openExternalActionRequesterAccountContextV1, openManagedControllerActionCodecV1, openManagedCreationActionCodecV1, projectRequesterSessionCredentialDisclosure } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { ManagedMachineV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { ManagedMachinePresetV1Schema } from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';
import { managedMachineActionEndpointPathV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { projectExternalActionManagedAdmissionV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { dispatchManagedSessionStart, dispatchOriginalAccountAction, readExternalActionRequesterInvocation, requiresOriginalAccountMachineActionProof } from './externalActionExecutionAuthorization';
import { resolvePluginActionCaller } from '@/plugins/runtime/invocation/services/actionCaller';
import { PluginMachineMaterializationRefV1Schema } from '@happier-dev/protocol/plugins/availability/materializationRefV1';
import { encodeStoredCredentials, updateSettings, readStoredCredentialsForServerId, writeStoredCredentialsForServerId, type StoredCredentials } from '@/persistence';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { createLocalServiceActionConfirmationNonceV1, LocalServiceActionRequestV1Schema,
  LocalServiceActionResultV1Schema } from '@happier-dev/protocol/local/services/actions/v1';
import { AUTOMATION_ACTION_INDEX_HTTP_PATH_V1, ActionAutomationIndexV1Schema } from '@happier-dev/protocol/automations/automationActionTriggerV1';
import { AccountSettingsV2HistoryListResponseSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { handleActionsCommand } from '@/cli/commands/actions';
import { parseQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { DATABASE_STATEMENT_RUN_ACTION_ID_V1, DATABASE_TARGETS_LIST_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIdsDatabaseV1';
import { captureConsoleJsonOutput, captureConsoleText } from '@/testkit/logger/captureOutput';
import { listCompiledActionCliCommands } from '@/cli/actions/compiledCommands';
import { runCompiledActionCliCommand } from '@/cli/actions/executeCommand';
import { cmdSessionCreate } from '@/cli/commands/session/create';
import { AUTHORITY_CEILING_HEADER_V1 } from '@happier-dev/protocol/actions/invocationAuthority';
import { configuration } from '@/configuration';
import { withTempDir } from '@/testkit/fs/tempDir';
import { withConfiguredDaemonTestHome } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { SessionSpawnNewInputV2Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import { ManagedWakeTargetV1Schema } from '@happier-dev/protocol/machines/managed/managedIntentV1';
import { ManagedMachineActionInputSchemasV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { PROJECT_ACTION_INPUT_SCHEMAS_V1 } from '@happier-dev/protocol/actions/projectActionFamily';
import { effectiveCredentialAuthority, narrowCredentialAuthority } from '../../../server/sources/app/auth/effectiveCredentialAuthority';
import { AccountSecurityGetResponseV1Schema } from '@happier-dev/protocol/auth/accountSecurity';
import { AgentsModelsListInputSchema } from '@happier-dev/protocol/actions/specs/agentCatalog';
import { createDaemonControlApp } from '@/daemon/controlServer';
import { createDaemonExternalActionTargetResolver } from '@/daemon/externalActions/daemonExternalActionTargetResolver';
import { createCliActionExecutor } from '@/session/actions/createCliActionExecutor';
import { createAccountServerActionDeps } from '@/api/accountServerActionDeps';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import axios from 'axios';
import { createActionExecutor } from '@happier-dev/protocol/actions';
import { getActionSpec, PUBLIC_ACTION_OUTPUT_SCHEMAS } from '@happier-dev/protocol/actions/actionSpecs';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { projectExternalActionRequesterHttpAuthorization, resolveExternalActionServerRequestHeaders } from './externalActionExecutionAuthorization';
import { createCliActionDeps } from '@/session/actions/createCliActionDeps';
import { createDaemonDeploymentActionDeps } from '@/deployments/createDaemonDeploymentActionDeps';
import { createOwnServerDeploymentRuntimeForHost } from '@/deployments/targets/ownServer/ownServerDeploymentHostRuntime';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { computeActionInputApprovalDigestV1, computeActionReviewDigestV1 } from '@happier-dev/protocol/actions/decisionAuthority';
import { MachineRolesSetInputV1Schema } from '@happier-dev/protocol/actions/specs/machineRoles';
import * as machineRpc from '@/session/transport/rpc/machineRpc';
import { SIMULATOR_ACTION_ROUTE_UNAVAILABLE_RESULT_V1 } from '@happier-dev/protocol/devices/simulator/runtimeActionClient';

// Terminal reads and controlling-TTY availability are genuine user/OS boundaries;
// the consent owner and its default-no answer parsing stay real.
const terminal = vi.hoisted(() => ({ interactive: true, answer: 'no', prompts: [] as string[], onPrompt: null as (() => void) | null }));
vi.mock('@/terminal/prompts/promptInput', async importOriginal => ({
  ...await importOriginal<typeof import('@/terminal/prompts/promptInput')>(),
  isInteractiveTerminal: () => terminal.interactive,
  promptInput: async (message: string) => { terminal.prompts.push(message); terminal.onPrompt?.(); return terminal.answer; },
}));

const servers: Server[] = [];
const controlApps: ReturnType<typeof createDaemonControlApp>[] = [];
const homeIdentityId = 'srv_requester_home';
it.each([
  { mode: 'interactive', answer: 'y', interactive: true, structured: [] as string[], accepted: true },
  { mode: 'declined', answer: 'no', interactive: true, structured: [] as string[], accepted: false },
  { mode: 'json', answer: 'y', interactive: true, structured: ['--json'], accepted: false },
  { mode: 'jsonl', answer: 'y', interactive: true, structured: ['--jsonl', '--follow'], accepted: false },
  { mode: 'noninteractive', answer: 'y', interactive: false, structured: [] as string[], accepted: false },
])('keeps friendly Session creation requester disclosure explicit ($mode)', async scenario => {
  const events: string[] = [];
  const target = await home('plain', events, { originalOwnAction: 'session.spawn_new', ownExecution: {
    ok: true, result: { type: 'success', sessionId: 'member-session', disposition: 'created',
      executionTarget: { serverId: 'home', machineId: 'alice-machine' },
      organizationPlacement: { sectionId: null, tagIds: [] }, initialInput: { status: 'notRequested' } },
  } });
  terminal.interactive = scenario.interactive;
  terminal.answer = scenario.answer;
  terminal.onPrompt = () => {
    expect(events).not.toContain('dispatch');
    expect(target.readReceived()).toBeUndefined();
  };
  await withConfiguredDaemonTestHome({ prefix: 'session-create-disclosure-',
    env: { HAPPIER_SERVER_URL: target.url, HAPPIER_WEBAPP_URL: target.url } }, async () => {
    const output = captureConsoleText();
    try {
      const invocation = cmdSessionCreate(['create', '--machine-id', 'alice-machine', '--path', '/tmp',
        '--agent', 'codex', '--model', 'gpt-6-luna', '--spawn-attempt-id', 'request-1',
        '--title', 'Shared Computer Session', '--prompt', 'Reply with a greeting.', ...scenario.structured], {
        readCredentialsFn: async () => ({ token: token(), encryption: null, credentialProvenance: 'stored_session' }),
      });
      if (scenario.accepted || scenario.structured.length) await invocation;
      else await expect(invocation).rejects.toMatchObject({ code: 'requester_credential_disclosure_declined' });
      if (scenario.accepted) {
        expect(output.text()).toContain('member-session');
        const received = ExternalActionExecutionAuthorizationRequestV1Schema.parse(target.readReceived());
        expect(openExternalActionRequesterAccountContextV1({ authorization: received.executionAuthorization,
          purpose: { kind: 'external_action' }, machineId: 'alice-machine', installationId: 'alice-installation',
          serverIdentityId: homeIdentityId, installationPrivateKey: target.privateKey }))
          .toMatchObject({ token: token() });
      } else {
        expect(events).not.toContain('dispatch');
        expect(target.readReceived()).toBeUndefined();
        if (scenario.structured.length) expect(output.text()).toContain('requester_credential_disclosure_declined');
      }
      expect(terminal.prompts).toHaveLength(scenario.interactive && !scenario.structured.length ? 1 : 0);
    } finally { output.restore(); }
  });
});
it('resolves a Can-use member’s saved launch profile before routing Session creation to the owner', async () => {
  const profileId = 'member-codex-profile';
  const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
  const requesterProfileReads: boolean[] = [];
  const actionPaths: string[] = [];
  const target = await home('plain', [], {
    originalOwnAction: 'session.spawn_new',
    onRequestPath: path => {
      if (path?.startsWith(EXTERNAL_ACTION_HTTP_PATH_PREFIX_V1)) actionPaths.push(path);
    },
    launchProfile: { service, profileId, onRead: authorization => requesterProfileReads.push(authorization === `Bearer ${token()}`) },
    ownExecution: { ok: true, result: { type: 'success', sessionId: 'member-session', disposition: 'created',
      executionTarget: { serverId: homeIdentityId, machineId: 'alice-machine' },
      organizationPlacement: { sectionId: null, tagIds: [] }, initialInput: { status: 'notRequested' } } },
  });
  terminal.interactive = true;
  terminal.answer = 'y';
  await withConfiguredDaemonTestHome({ prefix: 'session-create-member-profile-',
    env: { HAPPIER_SERVER_URL: target.url, HAPPIER_WEBAPP_URL: target.url } }, async () => {
    const output = captureConsoleText();
    try {
      await cmdSessionCreate(['create', '--machine-id', 'alice-machine', '--path', '/tmp', '--agent', 'codex',
        '--auth', `cs:profile:${profileId}`, '--spawn-attempt-id', 'request-1'], {
        readCredentialsFn: async () => ({ token: token(), encryption: null, credentialProvenance: 'stored_session' }),
      });
      expect(output.text()).toContain('member-session');
      expect(requesterProfileReads).toContain(true);
      expect(actionPaths).toEqual([
        bindExternalActionExecutionAuthorizationHttpPathV1('session.spawn_new'),
        `${EXTERNAL_ACTION_HTTP_PATH_PREFIX_V1}session.spawn_new`,
      ]);
      const { envelope, executionAuthorization } = ExternalActionExecutionAuthorizationRequestV1Schema.parse(target.readReceived());
      expect(envelope).toMatchObject({ v: 1, input: { connectedServices: { v: 2, bindingsByServiceId: {
        [`${service.pluginId}/${service.localId}`]: { source: 'connected', selection: 'profile', profileId },
      } } } });
      expect(executionAuthorization?.binding).toMatchObject({ accountId: 'bob', custodianAccountId: 'alice' });
    } finally { output.restore(); }
  });
});
it('retains Home preset refusal through the friendly managed acquire command without a Session', async () => {
  const presetReads: unknown[] = [];
  // Only Home HTTP is substituted; CLI parsing, requester projection and preset routing stay real.
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/v1/machines/presets/get') {
      presetReads.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      response.end(JSON.stringify({ kind: 'refused', code: 'preset_not_found' }));
    } else {
      response.statusCode = 404;
      response.end(JSON.stringify({ error: 'not_found' }));
    }
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected an HTTP fixture address');
  const credentials: StoredCredentials = { token: token(), credentialProvenance: 'stored_session',
    encryption: { type: 'legacy', secret: new Uint8Array(32).fill(23) } };
  const command = listCompiledActionCliCommands().find(row => row.actionId === 'machines.managed.acquire');
  if (!command) throw new Error('Expected the managed acquire CLI command');
  const selection = { kind: 'preset', homeId: homeIdentityId, id: 'delegated-preset', revision: 1 };
  const output = captureConsoleJsonOutput();
  try {
    await runCompiledActionCliCommand({ command,
      argv: [...command.path, '--selection-json', JSON.stringify(selection), '--json'],
      deps: { readCredentialsFn: async () => credentials,
        getServerProfileFn: async () => { throw new Error('No implicit saved Home in this fixture'); },
        createExecutorFn: params => createCliActionExecutorFromCredentials({ ...params,
          serverId: 'home', serverApiUrl: `http://127.0.0.1:${address.port}`, serverIdentityId: homeIdentityId,
          actionsSettingsProvider: { getActionsSettings: () => normalizeActionsSettingsV1({ v: 1 }) },
        }),
      },
    });
    expect(output.json()).toMatchObject({ ok: false, error: { code: 'preset_not_found' } });
    expect(presetReads).toEqual([{ homeId: homeIdentityId, id: 'delegated-preset' }]);
  } finally { output.restore(); }
});
// Model discovery requires requester custody and exercises transport custody; settings.list
// is Account-local declaration discovery and does not originate a Machine call.
const ownMachineInput = AgentsModelsListInputSchema.parse({ agentId: 'codex', machineId: 'alice-machine' });
const ownMachineResult = PUBLIC_ACTION_OUTPUT_SCHEMAS['agents.models.list'].parse({ items: [] });
it.each(['plain', 'e2ee'] as const)(
  'keeps friendly CLI service reads credential-free on shared guests (%s)', async mode => {
    // Generic Machine RPC is the network boundary that loses requester custody.
    const genericRpc = vi.spyOn(machineRpc, 'callExactMachineRpc').mockRejectedValue(
      Object.assign(new Error('requester_credentials_unavailable'), { code: 'requester_credentials_unavailable' }));
    try {
      const events: string[] = [];
      const result = { kind: 'snapshot', services: [] };
      const target = await home(mode, events, { originalOwnAction: 'machines.services.list',
        authenticationKind: 'terminal', machineRole: 'manage',
        custodianAccountId: 'alice', ownExecution: { ok: true, result } });
      const disclosures: string[] = [];
      const credentials: StoredCredentials = { token: token('terminal'), credentialProvenance: 'stored_session',
        encryption: mode === 'plain' ? null : { type: 'legacy', secret: new Uint8Array(32).fill(23) } };
      const executor = createCliActionExecutorFromCredentials({ credentials,
        serverId: 'home', serverApiUrl: target.url, serverIdentityId: homeIdentityId,
        actionsSettingsProvider: { getActionsSettings: () => normalizeActionsSettingsV1({ v: 1 }) },
        onRequesterSessionCredentialDisclosure: async disclosure => {
          disclosures.push(disclosure.custodian?.accountId ?? 'missing');
          return false;
        } });
      const execution = await executor.execute('machines.services.list', { serverId: 'home', machineId: 'alice-machine' },
        { surface: 'cli', authority: 'account_automation', actionRequestId: 'request-1' });
      expect(disclosures).toEqual([]);
      expect(execution).toEqual({ ok: true, result });
      const received = ExternalActionExecutionAuthorizationRequestV1Schema.parse(target.readReceived());
      expect(received.envelope.v).toBe(mode === 'e2ee' ? 2 : 1);
      const requester = openExternalActionRequesterAccountContextV1({ authorization: received.executionAuthorization,
        purpose: { kind: 'external_action' }, machineId: 'alice-machine', installationId: 'alice-installation',
        serverIdentityId: homeIdentityId, installationPrivateKey: target.privateKey, includeInvocation: true });
      expect(requester).toBeNull();
      const codec = openManagedControllerActionCodecV1({ authorization: received.executionAuthorization,
        machineId: 'alice-machine', installationId: 'alice-installation', serverIdentityId: homeIdentityId,
        installationPrivateKey: target.privateKey, includeInvocation: true });
      expect(codec).toMatchObject({ invocation: { surface: 'cli' } });
      expect(codec).not.toHaveProperty('credentials');
      if (received.envelope.v === 2 && codec) {
        expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1,
          envelope: received.envelope, binding: { serverIdentityId: homeIdentityId, accountId: 'bob',
            authentication: { kind: 'terminal', tokenEpoch: 7 }, actionId: 'machines.services.list', requestId: 'request-1',
            target: { kind: 'machine', machineId: 'alice-machine' } }, material: codec.material })?.input)
          .toEqual({ serverId: homeIdentityId, machineId: 'alice-machine' });
      }
      expect(received.executionAuthorization?.binding).toMatchObject({ accountId: 'bob', custodianAccountId: 'alice' });
      expect(events).toEqual(['home-authorized', 'dispatch']);
    } finally {
      genericRpc.mockRestore();
    }
  });
it.each(['plain', 'e2ee'] as const)('dispatches an initial terminal read with an explicitly absent control cursor (%s)', async mode => {
  const actionId = 'machines.terminal.read';
  const requestId = 'request-1';
  const machineId = 'alice-machine';
  const machineTarget = { kind: 'machine' as const, machineId };
  const expectedInput = { serverId: homeIdentityId, machineId, terminalId: 'terminal',
    byteOffset: 0, holdForOutput: true };
  const execution = { ok: true as const, result: { ok: true, terminalId: 'terminal',
    frames: [], nextByteOffset: 0, availableByteOffset: 0, droppedBeforeByteOffset: 0,
    nextControlCursor: 0, holdForOutput: true, done: false } };
  const secret = new Uint8Array(32).fill(23);
  const target = await home(mode, [], { custodianAccountId: 'bob', originalOwnAction: actionId,
    machineRole: 'manage', authenticationKind: 'terminal', ownExecution: execution });

  await expect(dispatchOriginalAccountAction({ actionId, input: { ...expectedInput, controlCursor: undefined },
    requestId, target: machineTarget, credentials: { token: token('terminal'), credentialProvenance: 'stored_session',
      encryption: mode === 'plain' ? null : { type: 'legacy', secret } },
    serverHttpBaseUrl: target.url, serverIdentityId: homeIdentityId })).resolves.toEqual(execution);
  const { envelope } = ExternalActionExecutionAuthorizationRequestV1Schema.parse(target.readReceived());
  expect(envelope.v).toBe(mode === 'plain' ? 1 : 2);
  const deliveredInput = envelope.v === 1 ? envelope.input : openExternalActionRequestV2({
    projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope,
    binding: { serverIdentityId: homeIdentityId, accountId: 'bob', authentication: { kind: 'terminal', tokenEpoch: 7 },
      actionId, requestId, target: machineTarget },
    material: { type: 'dataKey', machineKey: deriveAccountMachineKeyFromRecoverySecret(secret) },
  })?.input;
  expect(deliveredInput).toEqual(expectedInput);
});

it.each(['accepted', 'declined', 'missing'] as const)(
  'retains requester credential consent for shared service logs (%s)', async consent => {
    const events: string[] = [];
    const target = await home('plain', events, { originalOwnAction: 'machines.services.logs.read',
      authenticationKind: 'account', ownExecution: { ok: true, result: { kind: 'page',
        page: { sourceRevision: 'generation', text: 'fixture log', nextCursor: null, truncated: false } } } });
    const disclosures: string[] = [];
    const credentials: StoredCredentials = { token: token(), encryption: null, credentialProvenance: 'stored_session' };
    const execution = await dispatchOriginalAccountAction({ actionId: 'machines.services.logs.read',
      input: { serverId: 'home', machineId: 'alice-machine', serviceId: 'service' },
      requestId: 'request-1', target: { kind: 'machine', machineId: 'alice-machine' }, credentials,
      serverHttpBaseUrl: target.url, serverIdentityId: homeIdentityId, authority: 'present_user',
      invocation: { caller: { kind: 'host' }, surface: 'cli', authority: 'present_user' },
      ...(consent === 'missing' ? {} : { onRequesterSessionCredentialDisclosure: async () => {
        disclosures.push('prompt'); return consent === 'accepted';
      } }) });
    expect(disclosures).toEqual(consent === 'missing' ? [] : ['prompt']);
    if (consent !== 'accepted') {
      expect(execution).toMatchObject({ ok: false, errorCode: consent === 'missing'
        ? 'requester_credential_disclosure_required' : 'requester_credential_disclosure_declined' });
      expect(events).not.toContain('dispatch');
      return;
    }
    expect(execution, JSON.stringify(execution)).toMatchObject({ ok: true });
    const received = ExternalActionExecutionAuthorizationRequestV1Schema.parse(target.readReceived());
    expect(openExternalActionRequesterAccountContextV1({ authorization: received.executionAuthorization,
      purpose: { kind: 'external_action' }, machineId: 'alice-machine', installationId: 'alice-installation',
      serverIdentityId: homeIdentityId, installationPrivateKey: target.privateKey, includeInvocation: true }))
      .toMatchObject({ credentials: { token: credentials.token }, invocation: { surface: 'cli' } });
  });
it('retains requester credential consent for shared service watch effects', async () => {
  const events: string[] = [];
  const target = await home('plain', events, { originalOwnAction: 'machines.services.unwatch', authenticationKind: 'terminal' });
  const execution = await dispatchOriginalAccountAction({ actionId: 'machines.services.unwatch',
    input: { serverId: 'home', machineId: 'alice-machine', watchId: 'watch', expectedRevision: 'revision' },
    requestId: 'request-1', target: { kind: 'machine', machineId: 'alice-machine' },
    credentials: { token: token('terminal'), encryption: null, credentialProvenance: 'stored_session' },
    serverHttpBaseUrl: target.url, serverIdentityId: homeIdentityId, authority: 'present_user',
    invocation: { caller: { kind: 'host' }, surface: 'cli', authority: 'present_user' } });
  expect(execution).toMatchObject({ ok: false, errorCode: 'requester_credential_disclosure_required' });
  expect(events).not.toContain('dispatch');
});
it('requires installed requester custody for private deployment observation reads', () => {
  expect(requiresOriginalAccountMachineActionProof('deployments.observation.get', {
    serverId: 'home', environmentId: 'environment', targetLinkId: 'runtime',
  })).toBe(true);
});

// QUERY: an own-local CLI must not skip Home for a database operation on a deployment target. Only the
// Home-minted root carries the deployment read admission that the data-role secret launch spends.
it('routes a deployment database operation through Home admission even on the daemon\'s own Machine', () => {
  const statement = parseQualifiedPluginActionId(DATABASE_STATEMENT_RUN_ACTION_ID_V1);
  const targets = parseQualifiedPluginActionId(DATABASE_TARGETS_LIST_ACTION_ID_V1);
  if (!statement || !targets) throw new Error('Expected canonical database Action identities');
  const environment = { serverId: 'home', projectSourceId: 'source', environmentId: 'environment' };
  const target = { kind: 'deployment_service', environment, deploymentId: 'deployment', targetLinkId: 'runtime',
    serviceId: 'database', database: 'app' };
  expect(requiresOriginalAccountMachineActionProof('action.invoke', { action: statement, input: {
    operation: 'statement.run', target, mode: 'read', statement: { sql: 'SELECT 1', parameters: [] } } })).toBe(true);
  // Listing targets opens no data role; a non-deployment plugin Action keeps its local root.
  expect(requiresOriginalAccountMachineActionProof('action.invoke', { action: targets, input: {
    scope: { kind: 'environment', environment } } })).toBe(false);
  expect(requiresOriginalAccountMachineActionProof('action.invoke', { action: { pluginId: 'happier.example', localId: 'echo' },
    input: { target } })).toBe(false);
});

it.each(['cli', 'ui'] as const)('enrolls real failure observers after admitted Link without Project requester authority (%s)', async surface => {
  const endpoint = 'https://link-observer-content.test';
  await withConfiguredDaemonTestHome({ prefix: 'link-observer-replay-' }, async () => runWithServerHttpBaseUrl(endpoint, async () => {
    const serverId = configuration.activeServerId;
    const installation = await readOrCreateInstallationIdentity();
    const credentials: StoredCredentials = { token: token(), encryption: null, credentialProvenance: 'stored_session' };
    const app = fastify();
    const requests: { path: string; status: number }[] = [];
    app.addHook('onResponse', async (request, reply) => { requests.push({ path: request.url, status: reply.statusCode }); });
    const phaseLog = vi.spyOn(logger, 'warnLocalFile');
    const restore = installAxiosFastifyAdapter({ app, origin: endpoint });
    const channel = await createRequesterCurrentnessSocketHarness();
    const accountFeatures = registerAccountHomeHttp(app, { accountId: 'bob', serverId: homeIdentityId });
    const features = FeaturesResponseSchema.parse({ ...accountFeatures, features: { ...accountFeatures.features,
      automations: { enabled: true }, workflows: { enabled: true } } });
    vi.stubGlobal('fetch', async () => Response.json(features));
    const artifacts = registerPlainArtifactRoutes(app, 'bob');
    for (const action of ['account.plugins.availability.intent.read', 'account.plugins.availability.intents.list'] as const) {
      const path = PluginAvailabilityActionHttpPathsV1[action];
      app.post(path, async request => readBundledPluginAvailabilityHttpFixture(path, request.body));
    }
    const environment = createDeploymentEnvironmentDetailV1();
    environment.environment.serverId = homeIdentityId;
    environment.environment.owner = { kind: 'account', accountId: 'bob' };
    environment.environment.controllerMachineId = 'machine';
    artifacts.seed(environment.environment.contentArtifactId,
      encodePlainArtifactStoredContent({ kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, title: environment.content.name }),
      encodePlainArtifactStoredContent({ body: JSON.stringify(environment.content) }));
    const link = createDeploymentTargetLinkHeaderV1({ environmentId: environment.environment.id, role: 'runtime',
      targetKind: 'platform', machines: [], members: [], state: 'configured', activeDeploymentId: undefined,
      source: { kind: 'plugin', contribution: { pluginId: 'happier.deploy.cloudflare', localId: 'pages' } } });
    environment.environment.runtimeTargetLinkId = link.id;
    const principal = { kind: 'account', accountId: 'bob', purpose: {
      consumer: { pluginId: 'happier.deploy.cloudflare', localId: 'targets-inspect-v1' }, purpose: 'deploy.manage' },
      target: { kind: 'account', account: { service: { pluginId: 'happier.deploy.cloudflare', localId: 'cloudflare' }, accountId: 'provider' } } };
    artifacts.seed(link.contentArtifactId,
      encodePlainArtifactStoredContent({ kind: DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1, title: 'Runtime' }),
      encodePlainArtifactStoredContent({ body: JSON.stringify({ credentialPrincipal: principal,
        providerIdentity: { providerAccountId: 'organization', providerResourceId: 'project', providerEnvironment: 'production' },
        providerEnvironment: { kind: 'native', selection: { kind: 'production' } } }) }));
    app.get(`/v1/deployments/environments/${environment.environment.id}`, async () => ({
      ok: true, environment: environment.environment, targetLinks: [link] }));
    const input = { environmentId: environment.environment.id, role: 'runtime' as const, source: link.source };
    const envelope = { v: 1 as const, requestId: `observer-${surface}`, target: { kind: 'machine' as const, machineId: 'machine' }, input };
    const root = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'admitted-link-root', binding: {
      accountId: 'bob', custodianAccountId: 'bob', authentication: { kind: 'account', tokenEpoch: 7 },
      accountEncryptionMode: 'plain', serverIdentityId: homeIdentityId, machineId: 'machine', installationId: installation.installationId,
      actionId: 'deployments.targets.link', requestId: envelope.requestId, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
      target: { kind: 'machine', machineId: 'machine' },
      deploymentLinkAdmission: { environmentId: environment.environment.id, owner: environment.environment.owner },
    } });
    // The network Home verifies this fixture's already-admitted root. Keep its
    // wire schema and actual installation signature; requester preparation stays real.
    const verifyPath = bindExternalActionExecutionAuthorizationVerifyHttpPathV1(root.binding.actionId);
    app.post(verifyPath, async request => {
      const body = ExternalActionExecutionAuthorizationVerifyRequestV1Schema.parse(request.body);
      expect(request.headers[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]).toBe(root.token);
      const signature = request.headers[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER];
      expect(typeof signature === 'string' && verifyExternalActionMachineRequestV1({
        authorizationToken: root.token, effectActionId: root.binding.actionId, target: root.binding.target,
        installationId: installation.installationId, requestId: root.binding.requestId, method: 'POST', path: verifyPath,
        body, publicKey: new Uint8Array(Buffer.from(installation.publicKey, 'base64url')), signature,
      })).toBe(true);
      return { ok: true };
    });
      const persisted = new Map<string, AutomationDefinitionDetail>();
      app.get('/v3/automations', async () => AutomationDefinitionListResponseSchema.parse({
        automations: [...persisted.values()].map(row => {
          const { executionRecipe: _recipe, observationOnly: _observation, templateCiphertext: _legacy, triggers, ...summary } = row;
          return { ...summary, triggers: triggers.map(trigger => {
            if (trigger.kind !== 'pluginEvent') throw new Error('Expected receipt Event fixture');
            const { triggerDefinitionEnvelope: _private, ...visible } = trigger;
            return visible;
          }) };
        }), nextCursor: null,
      }));
      app.post('/v3/automations/query', async () => ({ automations: [...persisted.values()], nextCursor: null }));
      // Home's Automation HTTP persistence is the boundary. The native writer,
      // trigger envelope codec and setup handler remain production implementations.
      const storedTrigger = (automationId: string, item: ReturnType<typeof AutomationDefinitionCreateRequestSchema.parse>['triggers'][number], revision: number) => {
        const trigger = item.trigger;
        if (trigger.kind !== 'pluginEvent' || trigger.observationTransport.kind !== 'checkpointedPull')
          throw new Error('Expected checkpointed receipt Event');
        const sourceSelectorId = 'sourceSelectorId' in trigger ? trigger.sourceSelectorId : crypto.randomUUID();
        const binding = { v: 1 as const, automationId, triggerId: item.triggerId, triggerRevision: revision, triggerKind: 'pluginEvent' as const,
          eventRef: trigger.eventRef, sourceSelectorId };
        const envelope = 'triggerDefinitionEnvelope' in trigger ? trigger.triggerDefinitionEnvelope
          : sealAutomationTriggerDefinitionStoredEnvelopeV1({ mode: 'plain', binding, definition: {
            v: 1, sourceInstanceId: trigger.sourceInstanceId, sourceConfig: trigger.sourceConfig,
            displayLabel: trigger.displayLabel, filter: trigger.filter, maximumObservationAgeMs: trigger.maximumObservationAgeMs } });
        return { id: item.triggerId, revision, kind: 'pluginEvent', enabled: trigger.enabled,
          createdAt: 1, updatedAt: 1, eventRef: trigger.eventRef, sourceSelectorId, sourceContractVersion: 1,
          observation: { kind: 'checkpointedPull', watcher: { ...trigger.observationTransport.watcherMaterializationRef,
            machineInstallationId: installation.installationId } }, sourceStatus: null, sourceCatalogStatus: null,
          triggerDefinitionEnvelope: typeof envelope === 'string' ? envelope : JSON.stringify(envelope) };
      };
      app.post('/v3/automations', async request => {
        const input = AutomationDefinitionCreateRequestSchema.parse(request.body);
        const row = AutomationDefinitionDetailSchema.parse({ id: input.automationId, name: input.name,
          description: null, enabled: input.enabled, targetType: null, existingSessionId: null, templateVersion: 1,
          lastRunAt: null, createdAt: 1, updatedAt: 1, workflowDefinitionId: null, scopeSessionId: null,
          observationOnly: input.observationOnly, assignments: [],
          triggers: input.triggers.map(item => storedTrigger(input.automationId, item, 0)) });
        persisted.set(row.id, row); return row;
      });
      app.get<{ Params: { id: string } }>('/v3/automations/:id', async (request, reply) =>
        persisted.get(request.params.id) ?? reply.code(404).send({ error: 'not_found' }));
      app.put<{ Params: { id: string } }>('/v3/automations/:id', async request => {
        const input = AutomationDefinitionReconcileRequestSchema.parse(request.body);
        const row = persisted.get(request.params.id);
        if (!row) throw new Error('Expected existing observation-only Automation');
        const next = AutomationDefinitionDetailSchema.parse({ ...row, name: input.name, enabled: input.enabled,
          templateVersion: row.templateVersion + 1, observationOnly: { ...row.observationOnly, templateVersion: row.templateVersion + 1 },
          triggers: input.triggers.map(item => {
            if (item.kind === 'new') return storedTrigger(row.id, item, 0);
            const retained = row.triggers.find(trigger => trigger.id === item.triggerId);
            if (!retained) throw new Error('Expected retained receipt trigger');
            if (item.trigger) return storedTrigger(row.id, { triggerId: item.triggerId,
              trigger: { ...item.trigger, enabled: item.enabled ?? retained.enabled } }, retained.revision + 1);
            return { ...retained, enabled: item.enabled ?? retained.enabled,
              revision: retained.revision + (item.enabled === undefined ? 0 : 1),
              ...(item.triggerDefinitionEnvelope ? { triggerDefinitionEnvelope: JSON.stringify(item.triggerDefinitionEnvelope) } : {}) };
          }) });
        persisted.set(row.id, next); return next;
      });
    const daemonWork = new AbortController();
    // The installed receiver binds deployment deps to the portable Home it observed (execution.ts deploymentHomeId).
    const native = createRequesterBoundDeploymentActionDeps({ credentials, serverId: homeIdentityId, serverHttpBaseUrl: endpoint, machineId: 'machine',
      resolveRequesterIdentity: async () => ({ kind: 'unknown', reason: 'requester_authority_unavailable' }) });
    const requesterExecutor = createActionExecutor({ ...createUnavailableActionTransportDeps(), ...native });
    // Durable approval roots have no private ports. Reacquire them through the
    // same installed Account and replay owners that execute a real Link approval.
    const prepare = createDaemonApprovalExecutionAuthorizationPreparer({ machineId: 'machine', serverId,
      serverBaseUrl: endpoint, daemonWorkSignal: daemonWork.signal,
      resolveCurrentMachineExecutionOriginContext: async () => ({ machineId: 'machine', serverIdentityId: homeIdentityId }),
      prepareRequesterAccountContext: request => prepareInstalledRequesterAccountActionContext({ ...request,
        purpose: { kind: 'external_action' }, machineId: 'machine', serverId,
        serverHttpBaseUrl: endpoint, ownCredentials: credentials,
        resolveCurrentMachineExecutionOriginContext: async () => ({ machineId: 'machine', serverIdentityId: homeIdentityId }),
        createExecutor: () => requesterExecutor }),
    });
    let prepared: Awaited<ReturnType<typeof prepare>> = null;
    try {
      prepared = await prepare({ authorization: root, originalActionEnvelope: envelope });
      const phases = phaseLog.mock.calls.flatMap(([tag, detail]) => tag === '[external-action-phase]'
        && detail && typeof detail === 'object' && 'phase' in detail ? [detail.phase] : []);
      expect(prepared, JSON.stringify({ phases, requests })).not.toBeNull();
      if (!prepared) throw new Error('Expected restored Link approval custody');
      const authorization = prepared.authorization;
      const runtime = await createAdmittedPluginRuntimeFixture({ runtimeOptions: {
        pluginIds: [DEPLOYMENT_RECEIPT_EVENT_REFS_V1.failed.pluginId, 'happier.deploy.cloudflare'],
        resolveCurrentMachineId: () => 'machine',
        externalActionHomeBinding: { serverId, serverIdentityId: homeIdentityId,
          externalActionMachineInstallationId: installation.installationId,
          externalActionMachineRequestPrivateKey: installation.privateKey },
        scopedActionRuntime: { credentials, actionsSettingsProvider: {
          getActionsSettings: () => normalizeActionsSettingsV1({ v: 1 }), getAccountSettings: () => ({}) } },
      } });
      try {
        // Receipt Events are declarations, not subscription registrations. Demand
        // their declared setup Actions through the daemon's executable owner.
        const setupDemands = Object.values(DEPLOYMENT_RECEIPT_EVENT_REFS_V1).map(ref => {
          const declared = runtime.registry.contributes.automationEligibleEvents?.find(candidate =>
            candidate.event.identity.pluginId === ref.pluginId && candidate.event.identity.localId === ref.localId);
          if (!declared) throw new Error('Expected the bundled receipt Event declaration');
          return { ...declared.event.automation.source.setupActionRef, family: 'actions' as const };
        });
        const activation = await runtime.registry.activateContributionsOnDemand(setupDemands);
        expect(activation, JSON.stringify(activation)).toEqual(expect.arrayContaining([
          expect.objectContaining({ pluginId: DEPLOYMENT_RECEIPT_EVENT_REFS_V1.failed.pluginId }),
        ]));
        expect(runtime.registry.resolveCurrentPluginMaterializationRef?.(DEPLOYMENT_RECEIPT_EVENT_REFS_V1.failed.pluginId))
          .toMatchObject({ machineId: 'machine', pluginId: DEPLOYMENT_RECEIPT_EVENT_REFS_V1.failed.pluginId });
        const acquire = () => runtime.controller.acquireRuntimeRegistry();
        const executor = createActionExecutor({ ...createCliActionDeps({ token: credentials.token, credentials, serverId,
          serverHttpBaseUrl: endpoint, sessionId: '',
          resolveServerFeaturesSnapshot: () => fetchServerFeaturesSnapshot({ serverUrl: endpoint, token: credentials.token }) }),
          invokeContributedAction: createCommittedContributedActionInvoker({ acquireRuntimeRegistryLease: acquire }) });
        const context: ActionExecutorContext = { surface, authority: 'account_automation', actionCaller: { kind: 'host' },
          runtimeAccountId: 'bob', serverId, serverIdentityId: homeIdentityId, actionRequestId: root.binding.requestId,
          originalActionEnvelope: envelope, externalActionTarget: root.binding.target,
          externalActionExecutionAuthorization: authorization,
          signExternalActionApprovalInput: prepared.signExternalActionApprovalInput };
        const readers = createDaemonDeploymentActionDeps({ credentials, serverId: homeIdentityId, serverHttpBaseUrl: endpoint,
          machineId: 'machine', resolveRequesterIdentity: async () => ({ kind: 'unknown', reason: 'requester_authority_unavailable' }) });
        const enrollment = createPlatformFailureEnrollmentForHost({ serverId: homeIdentityId, machineId: 'machine',
          acquirePluginRuntimeRegistryLease: acquire, readEnvironment: readers.readDeploymentEnvironment });
        const plan = await enrollment.prepare(input, context);
        if (!plan) throw new Error('Expected installed receipt Event enrollment plan');
        context.hostReviewedChild = createHostReviewedChildPortV1({ actionId: root.binding.actionId, input,
          context, plan, execute: (input, childContext, actionId) => executor.execute(actionId, input, childContext) });
        const linked = { ok: true as const, environmentId: environment.environment.id,
          revision: environment.environment.revision, targetLinkId: link.id, targetLinkRevision: link.revision };
        const completed = await enrollment.completeLink(linked, input, context);
        expect(completed, JSON.stringify({ completed, requests })).toMatchObject({ ...linked, failureObserver: { status: 'enrolled',
          sources: expect.arrayContaining(Object.values(DEPLOYMENT_RECEIPT_EVENT_REFS_V1).map(eventRef => ({
            automationId: expect.any(String), triggerId: expect.any(String), eventRef,
            sourceInstanceId: expect.any(String), filter: null, pendingObservation: { periodMs: 1000 } }))) } });
        const triggers = [...persisted.values()].flatMap(row => row.triggers.map(trigger => ({ row, trigger })));
        expect(triggers).toHaveLength(2);
        for (const { row, trigger } of triggers) {
          if (trigger.kind !== 'pluginEvent') throw new Error('Expected persisted receipt Event');
          const opened = openAutomationTriggerDefinitionStoredEnvelopeV1({ mode: 'plain',
            binding: { v: 1, triggerKind: 'pluginEvent', automationId: row.id, triggerId: trigger.id, triggerRevision: trigger.revision,
              eventRef: trigger.eventRef, sourceSelectorId: trigger.sourceSelectorId },
            envelope: JSON.parse(trigger.triggerDefinitionEnvelope) });
          expect(opened).toMatchObject({ kind: 'available', definition: { sourceConfig: { environmentId: environment.environment.id,
            targetLinkId: link.id, credentialPrincipal: principal } } });
        }
      } finally { await runtime.dispose(); }
    } finally { daemonWork.abort(); await prepared?.dispose?.(); await channel.close(); restore(); await app.close(); phaseLog.mockRestore(); vi.unstubAllGlobals(); }
  }));
});

it('keeps nested Link observation on its admitted native reader after rebuilding requester HTTP ports', async () => {
  const credentials: StoredCredentials = { token: token(), encryption: null, credentialProvenance: 'stored_session' };
  const host = { credentials, serverId: 'home', serverHttpBaseUrl: 'https://link-observer.test', machineId: 'machine',
    resolveRequesterIdentity: async () => ({ kind: 'unknown', reason: 'requester_authority_unavailable' } as const) };
  // The installed receiver binds deployment deps to the portable Home; the executor names it from the profile spelling.
  const native = createDaemonDeploymentActionDeps({ ...host, serverId: homeIdentityId,
    runtime: createOwnServerDeploymentRuntimeForHost({ ...host, serverId: homeIdentityId,
      acquirePluginRuntimeRegistryLease: async () => { throw new Error('Observation never acquires native execution'); } }) });
  const requesterExecutor = createActionExecutor({ ...createUnavailableActionTransportDeps(), ...native });
  const root = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'admitted-link-root', binding: {
    accountId: 'bob', custodianAccountId: 'bob', authentication: { kind: 'account', tokenEpoch: 7 },
    accountEncryptionMode: 'plain', serverIdentityId: homeIdentityId, machineId: 'machine', installationId: 'installation',
    actionId: 'deployments.targets.link', requestId: 'link-observer', requestEnvelopeDigest: 'a'.repeat(43),
    target: { kind: 'machine', machineId: 'machine' },
  } });
  Object.defineProperty(root, 'requesterAccountExecutor', { value: requesterExecutor, enumerable: false });
  // Only Home metadata is substituted. Projection, default CLI routing, Action
  // dispatch and the native observation/environment readers all stay real.
  const http = vi.spyOn(axios, 'request').mockResolvedValue({ status: 200,
    data: { ok: false, error: 'deployment_access_denied' } });
  try {
    const keys = new Uint8Array(32).fill(19);
    const privateKey = new Uint8Array([...keys, ...ed25519.getPublicKey(keys)]);
    const projected = await projectExternalActionRequesterHttpAuthorization({ authorization: root,
      serverId: host.serverId, serverIdentityId: homeIdentityId, serverHttpBaseUrl: host.serverHttpBaseUrl,
      target: root.binding.target, installationId: 'installation', privateKey, rootAdmitted: true });
    if (!projected) throw new Error('Expected admitted Link HTTP projection');
    const deps = createCliActionDeps({ token: credentials.token, credentials, serverId: host.serverId,
      serverHttpBaseUrl: host.serverHttpBaseUrl, sessionId: '' });
    // A signed root's input names the portable Home (deploymentHomeAdmission); the profile spelling is refused.
    const input = { serverId: homeIdentityId, environmentId: 'environment', targetLinkId: 'link' };
    const context = { surface: 'ui' as const, authority: 'present_user' as const, serverId: host.serverId, serverIdentityId: homeIdentityId,
      actionCaller: { kind: 'host' as const }, runtimeAccountId: 'bob', externalActionTarget: root.binding.target,
      externalActionExecutionAuthorization: projected };
    Object.defineProperty(root, 'requesterHttpProjection', { value: projected.requesterHttpProjection, enumerable: false });
    await expect(requesterExecutor.execute('deployments.observation.get', input,
      { ...context, externalActionExecutionAuthorization: root }))
      .resolves.toMatchObject({ ok: false, errorCode: 'deployment_access_denied' });
    await expect(deps.deploymentAction('deployments.observation.get', input,
      { ...context, externalActionExecutionAuthorization: root }))
      .resolves.toMatchObject({ ok: false, errorCode: 'deployment_access_denied' });
    // The readable refusal proves the native reader reached Home. A missing
    // executor instead asks storage to execute the transportless private Action.
    await expect(deps.deploymentAction('deployments.observation.get', input, context))
      .resolves.toMatchObject({ ok: false, errorCode: 'deployment_access_denied' });
  } finally { http.mockRestore(); }
});
it('projects a runtime plugin caller into private custody without losing admitted identity or upgrading authority', () => {
  const materialization = PluginMachineMaterializationRefV1Schema.parse({ pluginId: 'example.platform',
    machineId: 'machine-a', materializationId: 'materialization-a' });
  const caller = resolvePluginActionCaller({ plugin: { id: 'example.platform' },
    contribution: { id: 'observer', qualifiedId: 'example.platform/observer' }, occurrenceId: 'observer-occurrence',
    sourceCustody: { kind: 'development', registeredRootId: 'platform-source' },
    resolveCurrentPluginMaterializationRef: () => materialization });
  if (!caller) throw new Error('Expected a real admitted plugin caller');
  const invocation = readExternalActionRequesterInvocation({ surface: 'plugin', authority: 'account_automation', actionCaller: caller });
  expect(invocation).toMatchObject({ surface: 'plugin', authority: 'account_automation', caller: {
    kind: 'plugin', pluginId: 'example.platform', contributionLocalId: 'observer', occurrenceId: 'observer-occurrence',
    sourceCustody: { kind: 'development', registeredRootId: 'platform-source' }, materialization } });
  expect(invocation?.caller).not.toHaveProperty('contributionQualifiedId');
  expect(readExternalActionRequesterInvocation({ surface: 'plugin', authority: 'present_user', actionCaller: caller })).toBeUndefined();
  expect(readExternalActionRequesterInvocation({ surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' } }))
    .toEqual({ surface: 'cli', authority: 'present_user', caller: { kind: 'host' } });
});
it.each([{ refused: false, shared: false }, { refused: true, shared: false }, { refused: false, shared: true }])('keeps detached Review child requester custody and typed Role refusal through ordinary CLI admission (refused: $refused, shared: $shared)', async ({ refused, shared }) => {
  const events: string[] = [];
  const next = { runId: 'next-review-run', callId: 'next-call', sidechainId: 'next-sidechain' };
  const failure = { ok: false as const, errorCode: 'target_unavailable', error: 'Selected Role is unavailable' };
  const target = await home('plain', events, { originalOwnAction: 'execution.run.action', custodianAccountId: shared ? 'alice' : 'bob', machineRole: shared ? 'use' : 'manage',
    ownExecution: refused ? failure : { ok: true, result: { ok: true, result: next } } });
  const credentials: StoredCredentials = { token: token(), encryption: null, credentialProvenance: 'stored_session' };
  const disclose = vi.fn(async () => true);
  const genericRpc = vi.spyOn(machineRpc, 'callMachineRpc').mockRejectedValue(new Error('Bare Machine custody cannot prepare this Role'));
  try {
    const deps = createCliActionDeps({ token: credentials.token, credentials, serverId: 'home',
      serverIdentityId: homeIdentityId, serverHttpBaseUrl: target.url, sessionId: '', mode: 'plain', ctx: null,
      onRequesterSessionCredentialDisclosure: disclose });
    const result = await deps.executionRunAction!(null, { runId: 'retained-review-run', actionId: 'review.new_round', input: { fresh: true } }, {
      surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' }, actionRequestId: 'request-1',
      serverId: 'home', exactMachineId: 'alice-machine', runtimeAccountId: 'bob',
    });
    expect(result, JSON.stringify({ result, events, received: Boolean(target.readReceived()) })).toMatchObject(refused ? failure : { ok: true, result: next });
    const received = ExternalActionExecutionAuthorizationRequestV1Schema.parse(target.readReceived());
    expect(openExternalActionRequesterAccountContextV1({ authorization: received.executionAuthorization,
      purpose: { kind: 'external_action' }, machineId: 'alice-machine', installationId: 'alice-installation',
      serverIdentityId: homeIdentityId, installationPrivateKey: target.privateKey, includeInvocation: true }))
      .toMatchObject({ credentials: { token: credentials.token }, invocation: { caller: { kind: 'host' }, surface: 'cli', authority: 'present_user' } });
    expect(genericRpc).not.toHaveBeenCalled();
    expect(disclose).toHaveBeenCalledTimes(shared ? 1 : 0);
  } finally { genericRpc.mockRestore(); }
});
afterEach(async () => {
  terminal.interactive = true; terminal.answer = 'no'; terminal.prompts = []; terminal.onPrompt = null; process.exitCode = undefined;
  await Promise.all(controlApps.splice(0).map(app => app.close()));
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))));
});

function token(kind: 'account' | 'terminal' = 'account') {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none' })}.${encode({ sub: 'bob', tokenEpoch: 7, provenance: {
    v: 1, kind, authority: kind === 'account' ? 'present_user' : 'account_automation',
  } })}.signature`;
}

it.each([{ surface: 'mcp' as const }, { surface: 'cli' as const }])('delivers an agent simulator device operation through the original-Account Machine transport ($surface)', async ({ surface }) => {
  const caller = { kind: 'host' as const };
  const paths: string[] = [];
  // The app sends device operations as whole Actions; agent hosts reuse that
  // transport. Home and the receiving Machine decide; the CLI adds no check.
  const events: string[] = [];
  const operation = { platform: 'ios' as const, deviceId: 'device-1', operation: 'boot' as const };
  const target = await home('plain', events, { originalOwnAction: 'devices.simulator.device.boot', custodianAccountId: 'bob',
    machineRole: 'manage', ownExecution: { ok: true, result: { ok: true } }, onRequestPath: path => { if (path) paths.push(path); } });
  const credentials: StoredCredentials = { token: token(), encryption: null, credentialProvenance: 'stored_session' };
  const genericRpc = vi.spyOn(machineRpc, 'callExactMachineRpc').mockRejectedValue(new Error('Device operations are not Machine RPC'));
  try {
    const deps = createCliActionDeps({ token: credentials.token, credentials, serverId: 'home',
      serverIdentityId: homeIdentityId, serverHttpBaseUrl: target.url, sessionId: '', mode: 'plain', ctx: null });
    const result = await deps.runtimeActionExecute!({ actionId: 'devices.simulator.device.boot', input: operation, context: {
      surface, authority: 'account_automation', actionCaller: caller, actionRequestId: 'request-1', serverId: 'home',
      externalActionTarget: { kind: 'machine', machineId: 'alice-machine' } } });
    expect(result, JSON.stringify({ result, events })).toEqual({ ok: true });
    // Home answered the signed original-Account request for this exact Machine and input.
    expect(paths.some(path => path.startsWith('/v1/actions/'))).toBe(true);
    expect(genericRpc).not.toHaveBeenCalled();
  } finally { genericRpc.mockRestore(); }
});
it('keeps a Session caller off the original-Account route: its invocation contract carries host and Plugin callers only', async () => {
  const events: string[] = [];
  const target = await home('plain', events, { originalOwnAction: 'devices.simulator.device.boot', custodianAccountId: 'bob',
    machineRole: 'manage', ownExecution: { ok: true, result: { ok: true } } });
  const credentials: StoredCredentials = { token: token(), encryption: null, credentialProvenance: 'stored_session' };
  const deps = createCliActionDeps({ token: credentials.token, credentials, serverId: 'home',
    serverIdentityId: homeIdentityId, serverHttpBaseUrl: target.url, sessionId: '', mode: 'plain', ctx: null });
  expect(await deps.runtimeActionExecute!({ actionId: 'devices.simulator.device.boot',
    input: { platform: 'ios', deviceId: 'device-1', operation: 'boot' }, context: {
      surface: 'agent', authority: 'account_automation', actionCaller: { kind: 'session', sessionId: 'agent-session' },
      actionRequestId: 'request-1', serverId: 'home', externalActionTarget: { kind: 'machine', machineId: 'alice-machine' } } }))
    .toEqual(SIMULATOR_ACTION_ROUTE_UNAVAILABLE_RESULT_V1);
  expect(target.readReceived()).toBeUndefined();
});
it('returns the receiving refusal for an agent simulator device operation unchanged', async () => {
  const events: string[] = [];
  const refusal = { ok: false as const, errorCode: 'access_denied', error: 'access_denied' };
  const target = await home('plain', events, { originalOwnAction: 'devices.simulator.device.boot', custodianAccountId: 'bob',
    machineRole: 'manage', ownExecution: refusal });
  const credentials: StoredCredentials = { token: token(), encryption: null, credentialProvenance: 'stored_session' };
  const deps = createCliActionDeps({ token: credentials.token, credentials, serverId: 'home',
    serverIdentityId: homeIdentityId, serverHttpBaseUrl: target.url, sessionId: '', mode: 'plain', ctx: null });
  expect(await deps.runtimeActionExecute!({ actionId: 'devices.simulator.device.boot',
    input: { platform: 'ios', deviceId: 'device-1', operation: 'boot' }, context: {
      surface: 'mcp', authority: 'account_automation', actionCaller: { kind: 'host' }, actionRequestId: 'request-1', serverId: 'home',
      externalActionTarget: { kind: 'machine', machineId: 'alice-machine' } } })).toMatchObject(refusal);
});
it('refuses an agent simulator device operation on a Machine outside the caller\'s admitted inventory before dispatch', async () => {
  const events: string[] = [];
  const target = await home('plain', events, { originalOwnAction: 'devices.simulator.device.boot', custodianAccountId: 'alice',
    machineRole: 'use', ownExecution: { ok: true, result: { ok: true } } });
  const credentials: StoredCredentials = { token: token(), encryption: null, credentialProvenance: 'stored_session' };
  const deps = createCliActionDeps({ token: credentials.token, credentials, serverId: 'home',
    serverIdentityId: homeIdentityId, serverHttpBaseUrl: target.url, sessionId: '', mode: 'plain', ctx: null });
  const result = await deps.runtimeActionExecute!({ actionId: 'devices.simulator.device.boot',
    input: { platform: 'ios', deviceId: 'device-1', operation: 'boot' }, context: {
      surface: 'mcp', authority: 'account_automation', actionCaller: { kind: 'host' }, actionRequestId: 'request-1', serverId: 'home',
      externalActionTarget: { kind: 'machine', machineId: 'unadmitted-machine' } } });
  expect(result, JSON.stringify({ result, events })).toMatchObject({ ok: false });
  expect(target.readReceived()).toBeUndefined();
});
async function home(mode: 'plain' | 'e2ee', events: string[], options: {
  mutateRoot?: boolean; custodianAccountId?: string; authenticationKind?: 'account' | 'terminal';
  finiteWake?: boolean; accountOwnedFiniteWake?: boolean; finiteAction?: boolean;
  controllerCustodianAccountId?: string; controllerInventoryAbsent?: boolean;
  originalOwnAction?: ActionId; ownExecution?: ActionExecuteResult; onInventoryRead?: () => void; localDaemon?: boolean;
  contributedInvocationDenied?: boolean;
  machineRole?: 'use' | 'manage';
  ownHttpResponse?: Readonly<{ status: number; body: string }>;
  localDaemonExecution?: ActionExecuteResult;
  retireOwnAction?: boolean;
  retireAccountSecurity?: boolean;
  retireSessionAccess?: boolean;
  allowedTerminalSecurity?: boolean;
  authorityCeiling?: 'account_automation';
  beforeEncryptionRead?: () => Promise<void>;
  beforeInventoryRead?: () => Promise<void>;
  beforeAccountSecurityRead?: () => Promise<void>;
  onInstalledMachineRead?: () => void;
  installedCustodianAccountId?: string;
  passiveReadDelayMs?: number;
  invalidEncryptionResponse?: boolean;
  inventoryUnavailable?: boolean;
  malformedUnrelatedMachine?: boolean;
  onInventoryResponse?: (path: string, rowCount: number) => void;
  scopedManagedController?: boolean;
  managedEnrollmentAccountId?: string;
  scopedControllerMismatch?: 'parent' | 'installation' | 'resource' | 'account-owned';
  onRequestAuthorization?: (authorization: string | undefined) => void;
  launchProfile?: Readonly<{ service: { pluginId: string; localId: string }; profileId: string;
    onRead(authorization: string | undefined): void }>;
  onRequestPath?: (path: string | undefined) => void;
  artifacts?: ReturnType<typeof fastify>;
} = {}) {
  const seed = new Uint8Array(32).fill(19);
  const publicKey = ed25519.getPublicKey(seed);
  const controllerSeed = new Uint8Array(32).fill(29);
  const controllerPublicKey = ed25519.getPublicKey(controllerSeed);
  const defaultActionId = options.originalOwnAction ?? (options.finiteWake || options.finiteAction ? 'projects.script.run' : 'agents.models.list');
  let received: unknown;
  const retiredRequests: Array<Readonly<{ path: string; authorization: string | undefined; body?: unknown }>> = [];
  const securityPrincipals: Array<Readonly<{ authority: ReturnType<typeof effectiveCredentialAuthority>; authorization: string | undefined }>> = [];
  const server = createServer(async (request, response) => {
    if (options.artifacts && request.url?.startsWith('/v1/artifacts')) {
      return options.artifacts.routing(request, response);
    }
    const actionId = options.originalOwnAction === 'action.invoke' && request.url?.startsWith('/v1/actions/')
      ? ActionIdSchema.parse(request.url.split('/')[3]) : defaultActionId;
    options.onRequestPath?.(request.url);
    options.onRequestAuthorization?.(request.headers.authorization);
    const respond = (value: unknown) => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(value)); };
    if (request.url === AUTOMATION_ACTION_INDEX_HTTP_PATH_V1) {
      return respond(ActionAutomationIndexV1Schema.parse({ v: 1, rows: [] }));
    }
    const machine = { id: 'alice-machine', kind: 'persistent', active: true, revokedAt: null, replacedByMachineId: null,
      installationId: 'alice-installation', installationPublicKey: encodeBase64(publicKey), storageMode: 'plain',
      access: { custodian: { accountId: options.custodianAccountId ?? 'alice', displayName: 'Alice' }, role: options.machineRole ?? 'use', resourceMode: options.custodianAccountId === 'bob' ? mode : 'plain', accessState: 'ready' } };
    const controller = { ...machine, id: 'alice-controller', installationId: 'controller-installation',
      installationPublicKey: encodeBase64(controllerPublicKey),
      access: { ...machine.access, custodian: { accountId: options.controllerCustodianAccountId ?? 'alice', displayName: 'Alice' } } };
    if (request.url === '/v1/features' || request.url === '/v1/features/authenticated') {
      return respond(FeaturesResponseSchema.parse({ features: {}, capabilities: { serverIdentity: { serverIdentityId: homeIdentityId } } }));
    }
    if (request.url === '/v2/account/settings') return respond({ content: null, version: 0 });
    if (request.url === '/v2/account/settings/history') return respond(AccountSettingsV2HistoryListResponseSchema.parse({ snapshots: [] }));
    if (request.url === '/v1/account/profile') {
      const profile = options.launchProfile;
      profile?.onRead(request.headers.authorization);
      return respond(AccountProfileSchema.parse({ id: 'bob', ...(profile ? { connectedAccountsV4: [{
        ref: { service: profile.service, accountId: profile.profileId }, kind: 'oauth', status: 'connected',
        authenticationModeId: 'oauth', configurationReady: false, configurationRevision: null,
        revisionSemantics: 'revisioned', credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS', scopes: [],
      }] } : {}) }));
    }
    if (options.launchProfile && request.url?.endsWith('/connected-metadata/presentation')) {
      return respond({ status: 'present', revision: 1, content: { t: 'plain', v: { v: 1, entries: [] } } });
    }
    if (request.url === '/v1/account/encryption/currentness') return respond(createAccountEncryptionCurrentnessFixture({ mode, settingsVersion: 0 }));
    if (request.url === '/v1/account/encryption') {
      await options.beforeEncryptionRead?.();
      if (options.passiveReadDelayMs) await new Promise(resolve => setTimeout(resolve, options.passiveReadDelayMs));
      return respond(options.invalidEncryptionResponse ? { mode: 'invalid' } : { mode, updatedAt: 1 });
    }
    if (request.url === '/v1/machines') {
      options.onInventoryRead?.();
      await options.beforeInventoryRead?.();
      if (options.passiveReadDelayMs) await new Promise(resolve => setTimeout(resolve, options.passiveReadDelayMs));
      if (options.inventoryUnavailable) { response.statusCode = 503; return respond({ error: 'unavailable' }); }
      const rows = options.malformedUnrelatedMachine ? [machine, { id: 'unrelated-machine' }]
        : options.finiteWake ? [machine, controller] : [machine];
      options.onInventoryResponse?.(request.url, rows.length);
      return respond(rows);
    }
    // Ordinary targets have no managed row; the real asleep classifier reads
    // this Account endpoint before choosing its existing Machine transport.
    if (request.url === managedMachineActionEndpointPathV1('machines.managed.list')) return respond({ machines: [] });
    if (request.url === '/ping') return respond({ status: 'ok' });
    if (request.url === '/v1/machines/alice-machine') {
      const hostFacts = request.headers.accept === 'application/json;happier-machine-projection=host-facts';
      // Admission projects inventory host facts from the same full publication
      // whenever it also needs installation proof, so either read is the inventory read.
      if (!hostFacts) options.onInstalledMachineRead?.();
      options.onInventoryRead?.();
      await options.beforeInventoryRead?.();
      if (options.inventoryUnavailable) { response.statusCode = 503; return respond({ error: 'unavailable' }); }
      options.onInventoryResponse?.(request.url, 1);
      if (options.passiveReadDelayMs) await new Promise(resolve => setTimeout(resolve, options.passiveReadDelayMs));
      return respond({ machine: !hostFacts && options.installedCustodianAccountId
        ? { ...machine, access: { ...machine.access, custodian: { accountId: options.installedCustodianAccountId, displayName: 'Replacement owner' } } } : machine });
    }
    if (request.url === '/v1/machines/alice-controller') {
      if (options.controllerInventoryAbsent) { response.statusCode = 404; return respond({ error: 'not_found' }); }
      if (request.headers.accept === 'application/json;happier-machine-projection=host-facts') options.onInventoryResponse?.(request.url, 1);
      return respond({ machine: controller });
    }
    if (options.allowedTerminalSecurity && request.method === 'GET' && request.url === '/v1/account/security') {
      await options.beforeAccountSecurityRead?.();
      // The network fixture substitutes credential verification/current Account
      // storage only. The receiver's actual effective authority and narrowing
      // owners consume the received request beneath that boundary.
      const effective = effectiveCredentialAuthority({ credentialKind: 'terminal', mintedAuthority: 'account_automation' });
      securityPrincipals.push({ authority: narrowCredentialAuthority(effective, request.headers[AUTHORITY_CEILING_HEADER_V1]),
        authorization: request.headers.authorization });
      return respond(AccountSecurityGetResponseV1Schema.parse({ v: 1, encryptionMode: mode,
        nativeEmail: null, password: { status: 'not_enrolled', revision: null } }));
    }
    if (options.retireAccountSecurity && request.method === 'GET' && request.url === '/v1/account/security') {
      retiredRequests.push({ path: request.url, authorization: request.headers.authorization });
      events.push('account-security');
      response.statusCode = 401;
      return respond({ error: 'invalid_token' });
    }
    let raw = '';
    for await (const chunk of request) raw += String(chunk);
    const body: unknown = raw ? JSON.parse(raw) : {};
    const availability = readBundledPluginAvailabilityHttpFixture(request.url ?? '', body);
    if (availability) return respond(availability);
    if (request.url === managedMachineActionEndpointPathV1('machines.managed.get')) {
      if (options.scopedManagedController) events.push('managed-read');
      expect(body).toEqual({ homeId: homeIdentityId, managedId: 'retained-machine' });
      return respond(ManagedMachineV1Schema.parse({ id: 'retained-machine', homeId: homeIdentityId,
        custodianAccountId: options.custodianAccountId ?? 'alice', enrollmentAccountId: options.managedEnrollmentAccountId ?? 'bob',
        controller: options.scopedControllerMismatch === 'account-owned' ? undefined : {
          machineId: options.scopedControllerMismatch === 'parent' ? 'other-parent' : machine.id,
          installationId: options.scopedControllerMismatch === 'installation' ? 'other-installation' : machine.installationId },
        controllerAccess: { custodian: { accountId: 'alice' }, installationPublicKey: encodeBase64(publicKey, 'base64url') },
        launch: { provider: { pluginId: 'fixture.compute', localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: {} },
        allocation: 'unsubmitted', creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 0,
        retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false }));
    }
    if (options.retireSessionAccess && request.url === '/v2/sessions/access-grants/list') {
      retiredRequests.push({ path: request.url, authorization: request.headers.authorization, body });
      events.push('session-access');
      response.statusCode = 401;
      return respond({ error: 'invalid_token' });
    }
    if (options.localDaemon && request.url === '/actions/root/execute') {
      events.push('local-daemon'); received = body;
      return respond(options.localDaemonExecution ?? { ok: true, result: ownMachineResult });
    }
    if (options.authorityCeiling === 'account_automation'
      && !request.url?.endsWith('/verify')
      && request.headers[AUTHORITY_CEILING_HEADER_V1.toLowerCase()] !== 'account_automation') {
      response.statusCode = 401;
      return respond({ error: 'invalid_token' });
    }
    if (request.url?.endsWith('/execution-authorization')) {
      events.push('home-authorized');
      if (options.contributedInvocationDenied && actionId === 'action.invoke') {
        response.statusCode = 403;
        return respond({ error: 'credential_scope_denied', failureCause: {
          phase: 'execution_authorization', errorClass: 'Error', errorCode: 'machine_manage_required', httpStatus: null } });
      }
      const prepared = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
      const deploymentPreparationAdmission = projectExternalActionDeploymentPreparationEnvelopeAdmissionV1({ actionId, envelope: prepared.envelope });
      const workspaceSync = prepared.envelope.v === 1 ? projectWorkspaceSyncAdmissionInputV1(actionId, prepared.envelope.input)
        : prepared.envelope.workspaceSyncAdmission;
      let managedAdmission = actionId === 'machines.managed.power.set' || actionId === 'machines.managed.delete'
        ? prepared.envelope.v === 1 ? projectExternalActionManagedAdmissionV1(actionId, prepared.envelope.input)
          : prepared.envelope.managedAdmission
        : options.scopedManagedController || actionId === 'machines.managed.bootstrap.retry'
        ? projectExternalActionManagedAdmissionV1(actionId,
          { homeId: homeIdentityId, managedId: options.scopedControllerMismatch === 'resource' ? 'other-resource' : 'retained-machine',
            ...(actionId === 'machines.managed.bootstrap.retry' ? { expectedIntentRevision: 2 } : {}) }) : undefined;
      if (managedAdmission?.actionId === 'machines.managed.bootstrap.retry') managedAdmission = { ...managedAdmission,
        input: { ...managedAdmission.input, guestCli: { source: 'home-payload', line: '0.3', channel: 'stable', payloads: [{
          target: { os: 'linux', arch: 'x64' }, sha256: 'b'.repeat(64), url: '/v1/runtime/guest-cli/payloads/linux/x64',
        }] } } };
      const authorization: ExternalActionExecutionAuthorizationV1 = { v: 1, token: 'exact-home-root', binding: {
        accountId: 'bob', authentication: { kind: options.authenticationKind ?? 'account', tokenEpoch: 7 }, accountEncryptionMode: mode,
        serverIdentityId: homeIdentityId, custodianAccountId: options.custodianAccountId ?? 'alice', machineId: 'alice-machine',
        installationId: 'alice-installation', actionId, requestId: 'request-1',
        target: prepared.envelope.target!, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(prepared.envelope),
        ...(prepared.envelope.v === 2 ? { machineRuntimeDemand: prepared.envelope.machineRuntimeDemand } : {}),
        ...(workspaceSync ? { workspaceSyncAdmission: {
          relationshipId: workspaceSync.relationshipId ?? deriveWorkspaceSyncRelationshipId(prepared.envelope.requestId),
          sourceWorkspaceRefId: workspaceSync.sourceWorkspaceRefId,
          source: { actorAccountId: 'bob', custodianAccountId: machine.access.custodian.accountId,
            machineId: workspaceSync.sourceMachineId, installationId: machine.installationId,
            role: 'use' as const, encryptionMode: machine.access.resourceMode },
        } } : {}),
        ...(deploymentPreparationAdmission ? { deploymentPreparationAdmission } : {}),
        ...(managedAdmission ? { managedAdmission } : {}),
      } };
      if (options.finiteWake) authorization.managedFiniteWake = {
        target: ManagedWakeTargetV1Schema.parse({ homeId: homeIdentityId, managedId: 'managed-guest',
          enrolledMachineId: machine.id, expectedIntentRevision: 4,
          controller: options.accountOwnedFiniteWake ? undefined : { machineId: controller.id, installationId: controller.installationId },
          origin: { kind: 'finite-command', actionRequestId: 'request-1' }, reason: 'admitted-work' }),
        ...(controller.access.custodian.accountId !== 'bob' && controller.access.custodian.accountId !== machine.access.custodian.accountId
          ? { requesterCredentialDisclosure: controller.access.custodian } : {}),
        installationPublicKey: encodeBase64(controllerPublicKey, 'base64url'),
      };
      if (options.mutateRoot) authorization.binding.requestId = 'different-request';
      return respond(authorization);
    }
    // The Action delivery oracle only observes the Action POST. The Account
    // observer's transport requests are independent of private dispatch.
    if (request.method !== 'POST' || request.url !== `${EXTERNAL_ACTION_HTTP_PATH_PREFIX_V1}${actionId}`) {
      response.statusCode = 404;
      return respond({ error: 'not_found' });
    }
    events.push('dispatch');
    received = body;
    if (options.scopedManagedController) {
      const dispatched = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
      const authorization = dispatched.executionAuthorization!;
      const codec = openManagedControllerActionCodecV1({ authorization, machineId: machine.id,
        installationId: machine.installationId, serverIdentityId: homeIdentityId,
        installationPrivateKey: new Uint8Array([...seed, ...publicKey]) });
      expect(codec).not.toBeNull();
      expect(openExternalActionRequesterAccountContextV1({ authorization, machineId: machine.id,
        installationId: machine.installationId, serverIdentityId: homeIdentityId, purpose: { kind: 'external_action' },
        installationPrivateKey: new Uint8Array([...seed, ...publicKey]) })).toBeNull();
      const binding = { serverIdentityId: homeIdentityId, accountId: 'bob', authentication: { kind: 'account' as const, tokenEpoch: 7 },
        actionId, requestId: 'request-1', target: { kind: 'machine' as const, machineId: machine.id } };
      const expected = { homeId: homeIdentityId, managedId: 'retained-machine' };
      expect(dispatched.envelope.v === 2 ? openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: dispatched.envelope,
        binding, material: codec! })?.input : dispatched.envelope.input).toEqual(expected);
      const execution = { ok: true as const, result: { inspected: true } };
      return respond(dispatched.envelope.v === 2 ? prepareExternalActionResponseV2({ request: dispatched.envelope,
        binding, material: codec!, executedMachineId: machine.id, randomBytes: length => new Uint8Array(length).fill(6), execution }).response
        : { v: 1, actionId, requestId: 'request-1', execution });
    }
    if (options.originalOwnAction && options.ownHttpResponse) {
      response.statusCode = options.ownHttpResponse.status;
      return response.end(options.ownHttpResponse.body);
    }
    if (options.originalOwnAction && options.retireOwnAction) {
      retiredRequests.push({ path: request.url ?? '', authorization: request.headers.authorization, body });
      response.statusCode = 401;
      return respond({ error: 'invalid_token' });
    }
    const original = ExternalActionRequestEnvelopeSchema.safeParse(body);
    if (options.originalOwnAction && original.success) {
      const execution = options.ownExecution ?? { ok: true,
        result: actionId === 'agents.models.list' ? ownMachineResult : { items: [] } };
      if (original.data.v === 2) {
        const binding = { serverIdentityId: homeIdentityId, accountId: 'bob', authentication: { kind: options.authenticationKind ?? 'account', tokenEpoch: 7 },
          actionId, requestId: 'request-1', target: { kind: 'machine' as const, machineId: 'alice-machine' } };
        const material = { type: 'dataKey' as const, machineKey: deriveAccountMachineKeyFromRecoverySecret(new Uint8Array(32).fill(23)) };
        expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: original.data, binding, material })?.input)
          .toEqual(actionId === 'agents.models.list' ? ownMachineInput : {});
        return respond(prepareExternalActionResponseV2({ request: original.data, binding, material,
          executedMachineId: 'alice-machine', randomBytes: length => new Uint8Array(length).fill(6), execution }).response);
      }
      return respond({ v: 1, actionId, requestId: 'request-1', execution });
    }
    // The incumbent own finite producer initially posts its plain envelope;
    // preserving this wire boundary lets its missing Home hint fail observably.
    const dispatched = ExternalActionExecutionAuthorizationRequestV1Schema.safeParse(body);
    if (!dispatched.success) return respond({ v: 1, actionId, requestId: 'request-1',
      execution: { ok: false, errorCode: 'fixture_receipt', error: 'fixture_receipt' } });
    const execution: ActionExecuteResult = options.originalOwnAction === 'action.invoke' && actionId === 'action.spec.get'
      ? { ok: true, result: PUBLIC_ACTION_OUTPUT_SCHEMAS['action.spec.get'].parse({ actionSpec: {
          id: 'happier.machine.services/actions/machine-online/setup', title: 'Machine online', description: null,
          safety: 'safe', executionPlacement: 'machine', placements: [], slash: null, bindings: null, examples: null,
          surfaces: { cli: true }, inputHints: null, inputSchema: { type: 'object' } } }) }
      : options.ownExecution ?? (options.originalOwnAction === 'agents.models.list'
      ? { ok: true, result: ownMachineResult }
      : { ok: false, errorCode: 'fixture_receipt', error: 'fixture_receipt' });
    const codec = openManagedControllerActionCodecV1({ authorization: dispatched.data.executionAuthorization,
      machineId: machine.id, installationId: machine.installationId, serverIdentityId: homeIdentityId,
      installationPrivateKey: new Uint8Array([...seed, ...publicKey]) });
    if (dispatched.data.envelope.v === 2) return respond(prepareExternalActionResponseV2({ request: dispatched.data.envelope,
      binding: { serverIdentityId: homeIdentityId, accountId: 'bob', authentication: { kind: options.authenticationKind ?? 'account', tokenEpoch: 7 },
        actionId, requestId: 'request-1', target: { kind: 'machine', machineId: 'alice-machine' } },
      material: codec ?? { type: 'dataKey', machineKey: deriveAccountMachineKeyFromRecoverySecret(new Uint8Array(32).fill(23)) },
      executedMachineId: 'alice-machine', randomBytes: length => new Uint8Array(length).fill(6),
      execution }).response);
    return respond({ v: 1, actionId, requestId: 'request-1', execution });
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Home fixture did not listen');
  return { url: `http://127.0.0.1:${address.port}`, readReceived: () => received, readRetiredRequests: () => retiredRequests,
    readSecurityPrincipals: () => securityPrincipals,
    privateKey: new Uint8Array([...seed, ...publicKey]),
    controllerPrivateKey: new Uint8Array([...controllerSeed, ...controllerPublicKey]) };
}

async function privateAccountDaemon(serverApiUrl: string, events: string[]) {
  const credentials: StoredCredentials = { token: token(), encryption: null, credentialProvenance: 'stored_session' };
  const executor = createCliActionExecutor({
    token: credentials.token, credentials, serverId: 'home', serverHttpBaseUrl: serverApiUrl,
    sessionId: '', mode: 'plain', ctx: null,
    actionsSettingsProvider: { getActionsSettings: () => normalizeActionsSettingsV1({ v: 1 }) },
    accountServerActionDeps: createAccountServerActionDeps({
      token: credentials.token, credentials, serverId: 'home', serverHttpBaseUrl: serverApiUrl,
    }),
  });
  const app = createDaemonControlApp({
    getChildren: () => [], machineId: 'alice-machine', controlToken: 'test-daemon-control',
    stopSession: async () => { throw new Error('Unexpected process stop'); },
    spawnSession: async () => { throw new Error('Unexpected process spawn'); },
    requestShutdown: () => { throw new Error('Unexpected daemon shutdown'); }, onHappySessionWebhook: () => {},
    externalActionApi: { currentServerId: 'home', currentAccountId: 'bob', executor,
      verifyPat: async () => { throw new Error('Private control does not verify PATs'); },
      resolveTarget: createDaemonExternalActionTargetResolver({ credentials, serverApiUrl }),
    },
  });
  controlApps.push(app);
  let received: unknown;
  app.addHook('preHandler', async request => {
    if (request.url === '/actions/root/execute' && request.headers['x-happier-daemon-token'] === 'test-daemon-control') {
      received = request.body; events.push('local-daemon');
    }
  });
  // A retired terminal bearer alone cannot enter the independently authenticated
  // private control route. The production client must possess its control token.
  expect((await app.inject({ method: 'POST', url: '/actions/root/execute',
    headers: { authorization: `Bearer ${token('terminal')}` },
    payload: { actionId: 'account.security.get', input: {} },
  })).statusCode).toBe(401);
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('Private daemon fixture did not listen');
  return { url: `http://127.0.0.1:${address.port}`, readReceived: () => received };
}

it('spends the same contributed requester custody through CLI and native HTTP ports', async () => {
  await withConfiguredDaemonTestHome({ prefix: 'contributed-http-custody-' }, async () => {
    const endpoint = 'https://contributed-http-custody.test';
    const serverId = configuration.activeServerId;
    const installation = await readOrCreateInstallationIdentity();
    const privateKey = new Uint8Array(Buffer.from(installation.privateKey, 'base64url'));
    const app = fastify();
    const features = registerAccountHomeHttp(app, { accountId: 'bob', serverId: homeIdentityId });
    vi.stubGlobal('fetch', async () => Response.json(features));
    const restore = installAxiosFastifyAdapter({ app, origin: endpoint });
    const credentials: StoredCredentials = { token: token(), encryption: null, credentialProvenance: 'stored_session' };
    const root = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'admitted-health-preview', binding: {
      accountId: 'bob', custodianAccountId: 'alice', authentication: { kind: 'account', tokenEpoch: 7 },
      accountEncryptionMode: 'plain', serverIdentityId: homeIdentityId, machineId: 'alice-machine',
      installationId: installation.installationId, actionId: 'action.invoke', requestId: 'health-preview',
      requestEnvelopeDigest: 'a'.repeat(43), target: { kind: 'machine', machineId: 'alice-machine' },
    } });
    const channel = await createRequesterCurrentnessSocketHarness();
    let requester: Awaited<ReturnType<typeof admitRequesterAccountActionContext>> = null;
    try {
      requester = await runWithServerHttpBaseUrl(endpoint, () => admitRequesterAccountActionContext({ authorization: root, credentials,
        serverId, serverIdentityId: homeIdentityId, serverHttpBaseUrl: endpoint, isCurrent: async () => true }));
      if (!requester) throw new Error('Expected original requester custody');
      const projectionInput = { serverId, serverIdentityId: homeIdentityId, serverHttpBaseUrl: endpoint,
        target: root.binding.target, installationId: root.binding.installationId, privateKey,
        rootAdmitted: true as const };
      const projected = await projectExternalActionRequesterHttpAuthorization({ ...projectionInput,
        authorization: requester.authorization });
      if (!projected?.requesterHttpProjection) throw new Error('Expected native HTTP port');
      const request = { effectActionId: 'deployments.environments.get', method: 'GET',
        path: `/v1/deployments/environments/environment?serverId=${homeIdentityId}` };
      const cli = resolveExternalActionServerRequestHeaders({ ...request,
        context: { surface: 'plugin', authority: 'account_automation', externalActionTarget: root.binding.target,
          externalActionExecutionAuthorization: projected }, daemonToken: 'different-installed-account',
        serverIdentityId: homeIdentityId, installationId: root.binding.installationId, privateKey });
      expect(cli).toMatchObject({ ok: true, headers: { Authorization: `Bearer ${credentials.token}` } });
      const native = await projected.requesterHttpProjection.createRequestHeaders(request);
      expect(native).toEqual({ Authorization: `Bearer ${credentials.token}`,
        [AUTHORITY_CEILING_HEADER_V1]: 'account_automation' });
      const wireOnly = await projectExternalActionRequesterHttpAuthorization({ ...projectionInput, authorization: root });
      expect(await wireOnly?.requesterHttpProjection?.createRequestHeaders(request)).toBeNull();
    } finally { await requester?.dispose(); await channel.close(); restore(); await app.close(); vi.unstubAllGlobals(); }
  });
});

describe('ordinary CLI requester Account custody on the existing Action carrier', () => {
  it.each(['same', 'installation', 'target', 'account', 'home', 'automation', 'api-token'] as const)('reuses disclosed requester custody only for its exact installed target (%s)', async mismatch => {
    await withConfiguredDaemonTestHome({ prefix: 'ordinary-child-custody-' }, async () => {
      const events: string[] = [];
      const target = await home('plain', events, { originalOwnAction: 'agents.models.list' });
      const channel = await createRequesterCurrentnessSocketHarness();
      const credentials: StoredCredentials = { token: token(), encryption: null,
        credentialProvenance: mismatch === 'api-token' ? 'api_token' : 'stored_session' };
      const invocation = { caller: { kind: 'host' as const }, surface: 'cli' as const,
        authority: mismatch === 'automation' ? 'account_automation' as const : 'present_user' as const };
      const source = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'already-admitted-parent', binding: {
        accountId: 'bob', custodianAccountId: 'alice', authentication: { kind: 'account', tokenEpoch: 7 },
        accountEncryptionMode: 'plain', serverIdentityId: homeIdentityId,
        machineId: mismatch === 'target' ? 'other-machine' : 'alice-machine',
        installationId: mismatch === 'installation' ? 'other-installation' : 'alice-installation',
        actionId: 'agents.models.list', requestId: 'parent-request', requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1({
          v: 1, requestId: 'parent-request', target: { kind: 'machine', machineId: 'alice-machine' }, input: ownMachineInput }),
        target: { kind: 'machine', machineId: mismatch === 'target' ? 'other-machine' : 'alice-machine' },
      } });
      let requester: Awaited<ReturnType<typeof admitRequesterAccountActionContext>> = null;
      try {
        requester = await runWithServerHttpBaseUrl(target.url, () => admitRequesterAccountActionContext({
          authorization: source, credentials, invocation, serverId: configuration.activeServerId, serverIdentityId: homeIdentityId,
          serverHttpBaseUrl: target.url, isCurrent: async () => true,
        }));
        expect(requester).not.toBeNull();
        if (!requester) throw new Error('Expected admitted requester custody');
        const result = await dispatchOriginalAccountAction({ actionId: 'agents.models.list', input: ownMachineInput,
          requestId: 'request-1', target: { kind: 'machine', machineId: 'alice-machine' },
          credentials: mismatch === 'account' ? { ...credentials, token: credentials.token.replace('signature', 'other-signature') } : credentials,
          serverHttpBaseUrl: target.url, serverIdentityId: mismatch === 'home' ? 'other-home' : homeIdentityId,
          authority: invocation.authority, invocation,
          requesterCustody: requester.authorization });
        if (mismatch === 'same') {
          expect(result).toMatchObject({ ok: true, result: ownMachineResult });
          expect(events).toContain('dispatch');
          const delivered = ExternalActionExecutionAuthorizationRequestV1Schema.parse(target.readReceived());
          const opened = openExternalActionRequesterAccountContextV1({ authorization: delivered.executionAuthorization,
            machineId: 'alice-machine', installationId: 'alice-installation', serverIdentityId: homeIdentityId,
            purpose: { kind: 'external_action' }, installationPrivateKey: target.privateKey, includeInvocation: true });
          expect(opened?.invocation).toEqual(invocation);
          expect(opened?.credentials.token).toBe(credentials.token);
        } else {
          expect(result).toMatchObject({ ok: false, errorCode: mismatch === 'automation' || mismatch === 'api-token'
            ? 'requester_account_material_unavailable' : 'admission_unavailable' });
          expect(events).not.toContain('dispatch');
        }
      } finally { await requester?.dispose(); await channel.close(); }
    });
  });
  it.each(['stop', 'delete'] as const)('sends a foreign Manage %s through the installation codec without sharing Account material', async intent => {
    const actionId = intent === 'delete' ? 'machines.managed.delete' : 'machines.managed.power.set';
    const events: string[] = [];
    const target = await home('e2ee', events, { machineRole: 'manage', originalOwnAction: actionId,
      managedEnrollmentAccountId: 'alice' });
    const input = { homeId: homeIdentityId, managedId: 'retained-machine', intent, when: 'now',
      expectedRevision: 0, ...(intent === 'delete' ? { reviewedDependencies: true } : {}) };
    const result = await dispatchOriginalAccountAction({ actionId, input, requestId: 'request-1',
      target: { kind: 'machine', machineId: 'alice-machine' }, credentials: { token: token(), encryption: null },
      serverHttpBaseUrl: target.url, serverIdentityId: homeIdentityId });
    expect(result).toMatchObject({ ok: false, errorCode: 'fixture_receipt' });
    expect(events).toContain('dispatch');
    const delivered = ExternalActionExecutionAuthorizationRequestV1Schema.parse(target.readReceived());
    expect(delivered.envelope).toMatchObject({ v: 2, managedAdmission: { actionId, input } });
    const receiver = { authorization: delivered.executionAuthorization, machineId: 'alice-machine',
      installationId: 'alice-installation', serverIdentityId: homeIdentityId, installationPrivateKey: target.privateKey };
    expect(openManagedControllerActionCodecV1(receiver)).not.toBeNull();
    expect(openExternalActionRequesterAccountContextV1({ ...receiver, purpose: { kind: 'external_action' } })).toBeNull();
  });
  it.each(['plain', 'e2ee'] as const)('forwards exact Account power admission without selecting a native recovery controller (%s)', async mode => {
    const events: string[] = [];
    const target = await home(mode, events, { custodianAccountId: 'bob', originalOwnAction: 'machines.managed.power.set',
      scopedControllerMismatch: 'account-owned' });
    const input = { homeId: homeIdentityId, managedId: 'retained-machine', intent: 'stop', when: 'after-idle' };
    const result = await dispatchOriginalAccountAction({ actionId: 'machines.managed.power.set', input, requestId: 'request-1',
      target: { kind: 'machine', machineId: 'alice-machine' }, credentials: { token: token(), encryption: mode === 'plain' ? null
        : { type: 'legacy', secret: new Uint8Array(32).fill(23) } }, serverHttpBaseUrl: target.url, serverIdentityId: homeIdentityId });
    expect(result).toMatchObject({ ok: false, errorCode: 'fixture_receipt' });
    expect(events).toEqual(['home-authorized', 'dispatch']);
    const delivered = ExternalActionExecutionAuthorizationRequestV1Schema.parse(target.readReceived());
    expect(delivered.executionAuthorization?.binding.managedAdmission).toEqual({ actionId: 'machines.managed.power.set', input });
  });
  it.each(['plain', 'e2ee'] as const)('binds acquire through the envelope digest without a recovery projection (%s)', async mode => {
    const events: string[] = [];
    const target = await home(mode, events, { custodianAccountId: 'bob', originalOwnAction: 'machines.managed.acquire' });
    const input = ManagedMachineActionInputSchemasV1['machines.managed.acquire'].parse({
      enrollmentIdentity: { kind: 'guestProcess', role: 'sandbox' },
      selection: { kind: 'one-off', homeId: homeIdentityId,
        controller: { machineId: 'alice-machine', installationId: 'alice-installation' },
        launch: { provider: { pluginId: 'fixture.compute', localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: {} },
        retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false },
    });
    const result = await dispatchOriginalAccountAction({ actionId: 'machines.managed.acquire', input,
      requestId: 'request-1', target: { kind: 'machine', machineId: 'alice-machine' },
      credentials: { token: token(), encryption: mode === 'plain' ? null
        : { type: 'legacy', secret: new Uint8Array(32).fill(23) } },
      serverHttpBaseUrl: target.url, serverIdentityId: homeIdentityId });
    expect(result).toMatchObject({ ok: false, errorCode: 'fixture_receipt' });
    expect(events).toEqual(['home-authorized', 'dispatch']);
    const delivered = ExternalActionExecutionAuthorizationRequestV1Schema.parse(target.readReceived());
    expect(delivered.executionAuthorization?.binding.managedAdmission).toBeUndefined();
  });
  it.each(['plain', 'e2ee'] as const)('inspects the exact managed controller with an invocation codec and no requester credentials (%s)', async mode => {
    const events: string[] = [];
    const target = await home(mode, events, { scopedManagedController: true, inventoryUnavailable: true,
      originalOwnAction: 'machines.managed.inspect' });
    const credentials: StoredCredentials = { token: token(), credentialProvenance: 'stored_session',
      encryption: mode === 'plain' ? null : { type: 'legacy', secret: new Uint8Array(32).fill(23) } };
    const result = await dispatchOriginalAccountAction({ actionId: 'machines.managed.inspect',
      input: { homeId: homeIdentityId, managedId: 'retained-machine' }, requestId: 'request-1',
      target: { kind: 'machine', machineId: 'alice-machine' }, credentials,
      serverHttpBaseUrl: target.url, serverIdentityId: homeIdentityId,
      onRequesterSessionCredentialDisclosure: () => { throw new Error('Managed workspace inspection never discloses requester credentials'); } });
    expect(result).toEqual({ ok: true, result: { inspected: true } });
    expect(events).toEqual(['managed-read', 'home-authorized', 'dispatch']);
  });
  it.each(['parent', 'installation', 'resource', 'account-owned', 'wrong-home'] as const)('refuses managed controller %s substitution before installed delivery', async scopedControllerMismatch => {
    const events: string[] = [];
    const target = await home('plain', events, { scopedManagedController: true, inventoryUnavailable: true,
      originalOwnAction: 'machines.managed.inspect',
      scopedControllerMismatch: scopedControllerMismatch === 'wrong-home' ? undefined : scopedControllerMismatch });
    const result = await dispatchOriginalAccountAction({ actionId: 'machines.managed.inspect',
      input: { homeId: scopedControllerMismatch === 'wrong-home' ? 'srv_other_home' : homeIdentityId, managedId: 'retained-machine' }, requestId: 'request-1',
      target: { kind: 'machine', machineId: 'alice-machine' }, credentials: { token: token(), encryption: null },
      serverHttpBaseUrl: target.url, serverIdentityId: homeIdentityId });
    expect(result).toMatchObject({ ok: false, errorCode: scopedControllerMismatch === 'wrong-home' ? 'server_target_mismatch'
      : scopedControllerMismatch === 'parent' || scopedControllerMismatch === 'account-owned' ? 'controller_retired' : 'admission_unavailable' });
    expect(events).not.toContain('dispatch');
    if (scopedControllerMismatch === 'resource') expect(events).toEqual(['managed-read', 'home-authorized']);
  });
  it('refuses an Account-owned preset on Machine delivery when the input retains an undefined controller', async () => {
    // HTTP is the boundary; the public projection and native-target admission stay real.
    const server = createServer(async (request, response) => {
      for await (const _chunk of request) { /* consume the HTTP request */ }
      response.setHeader('Content-Type', 'application/json');
      // Saved Presets keep labels and launch choices in sealed content; the public row has no controller.
      response.end(JSON.stringify({ kind: 'found', preset: ManagedMachinePresetV1Schema.parse({
        id: 'portable-preset', homeId: homeIdentityId, revision: 1, owner: { kind: 'account', accountId: 'bob' },
        contentEncryptionMode: 'plain', content: { t: 'plain', v: {} }, recipients: [],
      }) }));
    });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected an HTTP fixture address');
    const input = ManagedMachineActionInputSchemasV1['machines.managed.acquire'].parse({
      selection: { kind: 'preset', homeId: homeIdentityId, id: 'portable-preset', revision: 1 },
      controller: undefined,
      retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
    });
    await expect(dispatchOriginalAccountAction({ actionId: 'machines.managed.acquire', input,
      requestId: 'request-1', target: { kind: 'machine', machineId: 'alice-machine' },
      credentials: { token: token(), encryption: null }, serverHttpBaseUrl: `http://127.0.0.1:${address.port}`,
      serverIdentityId: homeIdentityId })).resolves.toMatchObject({ ok: false, errorCode: 'controller_retired' });
  });
  it.each(['localServices.launcher.start', 'localServices.actions.stopManaged', 'localServices.actions.restartManaged',
    'projects.service.relocate', 'projects.open', 'projects.worker.status', 'projects.worker.copy.retire', 'deployments.prepare',
    'machines.processes.list', 'machines.vitals.get', 'machines.guard.get', 'machines.work.summary.get',
    'scm.diffSummary.generate', 'scm.diffSummary.draftPullRequest', 'scm.diffSummary.refine',
    'scm.diffSummary.addOutputs', 'scm.diffSummary.discuss'] as const)(
    'retains Home Machine admission instead of the own-Account shortcut for %s', async actionId => {
      const events: string[] = [];
      const target = await home('plain', events, { custodianAccountId: 'bob', originalOwnAction: actionId,
        ownExecution: { ok: false, errorCode: 'fixture_receipt', error: 'fixture_receipt' } });
      const input = actionId === 'deployments.prepare' ? DeploymentPrepareInputV1Schema.parse({ projectSourceId: 'source', sourceRevision: 1,
          repository: { kind: 'github', deployment: 'https://github.com', repository: 'prepare/app' }, baseCommit: 'a'.repeat(40),
          workspace: { kind: 'workspace-ref', serverId: homeIdentityId, id: 'workspace' },
          sessionRef: { serverId: homeIdentityId, sessionId: 'preparation-session' } }) : {};
      const result = await dispatchOriginalAccountAction({ actionId, input, requestId: 'request-1',
        target: { kind: 'machine', machineId: 'alice-machine' },
        credentials: { token: token(), encryption: null, credentialProvenance: 'stored_session' },
        serverHttpBaseUrl: target.url, serverIdentityId: homeIdentityId, foreignTargetOnly: true });
      expect(result).toMatchObject({ ok: false, errorCode: 'fixture_receipt' });
      const received = ExternalActionExecutionAuthorizationRequestV1Schema.parse(target.readReceived());
      expect(received.executionAuthorization?.binding).toMatchObject({ actionId, machineId: 'alice-machine',
        installationId: 'alice-installation', accountId: 'bob', custodianAccountId: 'bob' });
      expect(events).toEqual(['home-authorized', 'dispatch']);
    });

  it.each([
    { actionId: 'machines.agentIsolation.set', viaCli: false, input: { machineId: 'alice-machine', enabled: true, expectedMetadataVersion: 10,
      expectedPolicy: { enabled: false }, expectedPlanDigest: 'a'.repeat(64) } },
    { actionId: 'machines.services.list', viaCli: false, input: { machineId: 'alice-machine' } },
    // The native output fixture's empty role-policy mutation is a default-only
    // confirmation owner, outside the retained native proof families.
    { actionId: 'machines.roles.set', viaCli: false, input: MachineRolesSetInputV1Schema.parse({ serverId: homeIdentityId,
      machineId: 'alice-machine', expectedPolicy: { active: [] }, expectedMetadataVersion: 1, policy: { active: [] } }) },
    { actionId: 'machines.agentIsolation.set', viaCli: true, input: { machineId: 'alice-machine', enabled: true, expectedMetadataVersion: 10,
      expectedPolicy: { enabled: false }, expectedPlanDigest: 'a'.repeat(64) } },
    { actionId: 'machines.agentIsolation.set', viaCli: 'approval', input: { machineId: 'alice-machine', enabled: true, expectedMetadataVersion: 10,
      expectedPolicy: { enabled: false }, expectedPlanDigest: 'a'.repeat(64) } },
  ] as const)('retains carried native Machine confirmation in signed own-Account delivery ($actionId, CLI: $viaCli)', async ({ actionId, input, viaCli }) => {
    const events: string[] = [];
    const target = await home('plain', events, { custodianAccountId: 'bob', originalOwnAction: actionId, machineRole: 'manage',
      ownExecution: { ok: false, errorCode: 'fixture_receipt', error: 'fixture_receipt' } });
    const machineTarget = { kind: 'machine' as const, machineId: 'alice-machine' };
    const invocation = { caller: { kind: 'host' as const }, surface: viaCli ? 'cli' as const : 'ui' as const, authority: 'present_user' as const,
      ...(viaCli ? { defaultSessionId: 'confirmed-session' } : {}),
      presentUserConfirmation: { actionId, requestId: 'request-1', accountId: 'bob', serverId: homeIdentityId,
        target: machineTarget, inputDigest: computeActionInputApprovalDigestV1(actionId, input),
        reviewDigest: computeActionReviewDigestV1(actionId, { actionArgs: input, preview: { machineId: machineTarget.machineId } }) } };
    const credentials: StoredCredentials = { token: token(), encryption: null, credentialProvenance: 'stored_session' };
    const result = viaCli
      ? await createCliActionExecutorFromCredentials({ credentials, externalActionClient: true,
        serverId: 'home', serverApiUrl: target.url, serverIdentityId: homeIdentityId, machineId: machineTarget.machineId,
        actionsSettingsProvider: { getActionsSettings: () => normalizeActionsSettingsV1({ v: 1 }),
          // A witnessed approval delegates its Account Ask through the real
          // persisted policy owner, rather than a runtime-only policy override.
          ...(viaCli === 'approval' ? { getAccountSettings: () => ({}) } : {}) },
      }).execute(actionId, input, { surface: 'cli', actionRequestId: 'request-1', authority: 'present_user', defaultSessionId: 'confirmed-session',
        ...(viaCli === 'approval' ? { presentUserApproval: { actionId, requestId: 'request-1',
          inputDigest: invocation.presentUserConfirmation.inputDigest, reviewDigest: invocation.presentUserConfirmation.reviewDigest } }
          : { presentUserConfirmation: invocation.presentUserConfirmation }) })
      : await dispatchOriginalAccountAction({ actionId, input, requestId: 'request-1', target: machineTarget,
        credentials, serverHttpBaseUrl: target.url, serverIdentityId: homeIdentityId, authority: 'present_user', invocation });
    expect(result).toMatchObject({ ok: false, errorCode: 'fixture_receipt' });
    const received = ExternalActionExecutionAuthorizationRequestV1Schema.parse(target.readReceived());
    expect(received.executionAuthorization?.binding).toMatchObject({ actionId, accountId: 'bob', custodianAccountId: 'bob',
      machineId: machineTarget.machineId, installationId: 'alice-installation' });
    expect(openExternalActionRequesterAccountContextV1({ authorization: received.executionAuthorization,
      installationPrivateKey: target.privateKey, purpose: { kind: 'external_action' }, machineId: machineTarget.machineId,
      installationId: 'alice-installation', serverIdentityId: homeIdentityId, includeInvocation: true }))
      .toMatchObject({ invocation });
    expect(events).toEqual(['home-authorized', 'dispatch']);
  });

  it('keeps Account sharing outside native Machine proof selection', async () => {
    const events: string[] = [];
    const actionId = 'machines.access.grant.set' as const;
    const target = await home('plain', events, { custodianAccountId: 'bob', originalOwnAction: actionId });
    const result = await dispatchOriginalAccountAction({ actionId, input: { serverId: homeIdentityId, machineId: 'alice-machine',
      principal: { kind: 'account', accountId: 'other-person' }, level: 'view' }, requestId: 'request-1',
      target: { kind: 'machine', machineId: 'alice-machine' },
      credentials: { token: token(), encryption: null, credentialProvenance: 'stored_session' },
      serverHttpBaseUrl: target.url, serverIdentityId: homeIdentityId, foreignTargetOnly: true });
    expect(result).toBeNull();
    expect(target.readReceived()).toBeUndefined();
    expect(events).toEqual([]);
  });

  it('retains the original non-person invocation when a Prepare handoff dispatches the ordinary Session Action', async () => {
    const events: string[] = [];
    const target = await home('plain', events, { custodianAccountId: 'bob', originalOwnAction: 'session.spawn_new' });
    const invocation = { caller: { kind: 'host' as const }, surface: 'mcp' as const, authority: 'account_automation' as const,
      callerPermissionMode: 'read-only' as const, workspaceWrites: 'deny' as const };
    const result = await dispatchOriginalAccountAction({ actionId: 'session.spawn_new', input: {}, requestId: 'request-1',
      target: { kind: 'machine', machineId: 'alice-machine' },
      credentials: { token: token(), encryption: null, credentialProvenance: 'stored_session' },
      serverHttpBaseUrl: target.url, serverIdentityId: homeIdentityId, authority: 'account_automation', invocation });
    expect(result).toMatchObject({ ok: false, errorCode: 'fixture_receipt' });
    expect(target.readReceived()).toHaveProperty('executionAuthorization.requesterAccountContext');
    const received = ExternalActionExecutionAuthorizationRequestV1Schema.parse(target.readReceived());
    const opened = openExternalActionRequesterAccountContextV1({ authorization: received.executionAuthorization!,
      installationPrivateKey: target.privateKey, purpose: { kind: 'external_action' }, machineId: 'alice-machine',
      installationId: 'alice-installation', serverIdentityId: homeIdentityId, includeInvocation: true });
    expect(opened).toMatchObject({ invocation });
    expect(events).toEqual(['home-authorized', 'dispatch']);
  });

  it('retains plugin custody for a Machine Action outside the original proof family map', async () => {
    const events: string[] = [];
    const target = await home('plain', events, { custodianAccountId: 'bob', originalOwnAction: 'daemon.filesystem.listRoots' });
    const invocation = { caller: { kind: 'plugin' as const, pluginId: 'example.platform', contributionLocalId: 'observer' },
      surface: 'plugin' as const, authority: 'account_automation' as const };
    const result = await dispatchOriginalAccountAction({ actionId: 'daemon.filesystem.listRoots', input: {}, requestId: 'request-1',
      target: { kind: 'machine', machineId: 'alice-machine' },
      credentials: { token: token(), encryption: null, credentialProvenance: 'stored_session' },
      serverHttpBaseUrl: target.url, serverIdentityId: homeIdentityId, authority: 'account_automation', invocation });
    expect(target.readReceived()).toHaveProperty('executionAuthorization.requesterAccountContext');
    const received = ExternalActionExecutionAuthorizationRequestV1Schema.parse(target.readReceived());
    expect(openExternalActionRequesterAccountContextV1({ authorization: received.executionAuthorization!,
      installationPrivateKey: target.privateKey, purpose: { kind: 'external_action' }, machineId: 'alice-machine',
      installationId: 'alice-installation', serverIdentityId: homeIdentityId, includeInvocation: true })).toMatchObject({ invocation });
    expect(result).toMatchObject({ ok: false, errorCode: 'fixture_receipt' });
    expect(events).toEqual(['home-authorized', 'dispatch']);
  });

  it.each(['settings.list', 'projects.service.placement.set', 'machines.resources.policy.get',
    'machines.vitals.summaries.list', 'usage.sources.dismiss', 'projects.worker.preferences.get'] as const)(
    'preserves the original Account path for non-Machine Action %s', async actionId => {
      const events: string[] = [];
      const target = await home('plain', events, { custodianAccountId: 'bob', originalOwnAction: actionId });
      expect(await dispatchOriginalAccountAction({ actionId, input: {}, requestId: 'request-1',
        target: { kind: 'machine', machineId: 'alice-machine' },
        credentials: { token: token(), encryption: null, credentialProvenance: 'stored_session' },
        serverHttpBaseUrl: target.url, serverIdentityId: homeIdentityId, foreignTargetOnly: true })).toBeNull();
      expect(events).toEqual([]);
      expect(target.readReceived()).toBeUndefined();
    });

  it('captures credentials once for an Account Action after a local credential replacement', async () => {
    await withTempDir('happier-captured-account-action-', async taskDir => {
      const originalConfiguration = { serversDir: configuration.serversDir };
      Object.assign(configuration, { serversDir: join(taskDir, 'servers') });
      try {
        const credentials: StoredCredentials = { token: token('terminal'), encryption: null, credentialProvenance: 'stored_session' };
        await writeStoredCredentialsForServerId('home', credentials);
        const credentialFileReads = vi.spyOn(fsPromises, 'readFile');
        const readCredentials = vi.fn(() => readStoredCredentialsForServerId('home'));
        const sentAuthorizations: Array<string | undefined> = [];
        const target = await home('plain', [], { allowedTerminalSecurity: true,
          beforeAccountSecurityRead: () => writeStoredCredentialsForServerId('home', { ...credentials, token: token() }),
          onRequestAuthorization: authorization => { sentAuthorizations.push(authorization); } });
        const executor = createCliActionExecutorFromCredentials({ credentials, readCredentials,
          serverId: 'home', serverApiUrl: target.url, serverIdentityId: homeIdentityId,
          pluginActionExecutionOwner: 'current_process',
          actionsSettingsProvider: { getActionsSettings: () => normalizeActionsSettingsV1({ v: 1 }) } });
        expect(await executor.execute('account.security.get', {}, { surface: 'cli' }))
          .toMatchObject({ ok: true, result: { encryptionMode: 'plain' } });
        expect(readCredentials).toHaveBeenCalledTimes(1);
        expect(credentialFileReads.mock.calls.filter(([path]) => String(path) === join(configuration.serversDir, 'home', 'access.key')))
          .toHaveLength(1);
        expect(sentAuthorizations.length).toBeGreaterThan(0);
        expect(sentAuthorizations.every(value => value === `Bearer ${credentials.token}`)).toBe(true);
      } finally { Object.assign(configuration, originalConfiguration); }
    });
  });

  it.each([
    { actionId: 'execution.run.start', mode: 'plain', authenticationKind: 'account' },
    { actionId: 'execution.run.ensure', mode: 'plain', authenticationKind: 'account' },
    { actionId: 'execution.run.send', mode: 'plain', authenticationKind: 'account' },
    { actionId: 'execution.run.ensure_or_start', mode: 'plain', authenticationKind: 'account' },
    { actionId: 'execution.run.start', mode: 'e2ee', authenticationKind: 'terminal' },
    { actionId: 'execution.run.start', mode: 'plain', authenticationKind: 'account', sessionId: 'existing-session' },
  ] as const)(
    'admits own Run $actionId ($authenticationKind, $mode, $sessionId) through its scoped requester owner', async testCase => {
      const { actionId, mode, authenticationKind } = testCase;
      const sessionId = 'sessionId' in testCase ? testCase.sessionId : null;
      await withTempDir('happier-own-run-requester-', async taskDir => {
        const previousServersDir = configuration.serversDir;
        configuration.serversDir = join(taskDir, 'servers');
        try {
          const events: string[] = [];
          const target = await home(mode, events, { custodianAccountId: 'bob', originalOwnAction: actionId, authenticationKind,
            allowedTerminalSecurity: authenticationKind === 'terminal',
            localDaemon: true, localDaemonExecution: { ok: false, errorCode: 'project_requester_credentials_unavailable' } });
          const serverDir = join(configuration.serversDir, 'home');
          await mkdir(serverDir, { recursive: true });
          await writeFile(join(serverDir, 'daemon.state.json'), JSON.stringify({ pid: process.pid,
            httpPort: Number(new URL(target.url).port), startedAt: Date.now(), startedWithCliVersion: 'test',
            machineId: 'alice-machine', accountId: 'bob', controlToken: 'test-daemon-control' }));
          const executor = createCliActionExecutorFromCredentials({
            credentials: { token: token(authenticationKind), encryption: mode === 'plain' ? null
              : { type: 'legacy', secret: new Uint8Array(32).fill(23) }, credentialProvenance: 'stored_session' },
            // Direct Machine Run CLI commands do not force the external client transport.
            ...(sessionId ? { externalActionClient: true } : {}),
            serverId: 'home', serverApiUrl: target.url, serverIdentityId: homeIdentityId,
            machineId: 'alice-machine',
            actionsSettingsProvider: { getActionsSettings: () => normalizeActionsSettingsV1({ v: 1 }) },
          });
          const start = { sessionId, intent: 'agent', backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
            cwd: taskDir, instructions: 'Read only', permissionMode: 'read_only', retentionPolicy: 'resumable',
            runClass: 'long_lived', ioMode: 'request_response' };
          const input = getActionSpec(actionId).inputSchema.parse(actionId === 'execution.run.start' ? start
            : actionId === 'execution.run.ensure_or_start' ? { sessionId: null, start }
            : actionId === 'execution.run.ensure' ? { sessionId: null, runId: 'retained-run', resume: true }
              : { sessionId: null, runId: 'retained-run', message: 'Continue', resume: true, delivery: 'prompt' });
          const result = await executor.execute(actionId, input, { surface: 'cli', actionRequestId: 'request-1' });
          if (sessionId) {
            expect(result).toMatchObject({ errorCode: 'project_requester_credentials_unavailable' });
            expect(events).toEqual(['local-daemon']);
            return;
          }
          expect(result).toMatchObject({ errorCode: 'fixture_receipt' });
          const received = ExternalActionExecutionAuthorizationRequestV1Schema.parse(target.readReceived());
          expect(received.executionAuthorization?.binding).toMatchObject({ actionId, accountId: 'bob', custodianAccountId: 'bob' });
          expect(events).toEqual(['home-authorized', 'dispatch']);
        } finally { configuration.serversDir = previousServersDir; }
      });
    });

  it.each([
    { status: 502, body: '', expected: 'outcome_unknown' },
    { status: 502, body: 'malformed-response', expected: 'project_transport_unavailable' },
    { status: 503, body: '', expected: 'project_transport_unavailable' },
    { status: 403, body: JSON.stringify({ error: 'invalid_request', code: 'target_unavailable' }), expected: 'target_unavailable' },
  ])('distinguishes a submitted empty HTTP 502 from transport refusals ($status, $body)', async ({ status, body, expected }) => {
    const events: string[] = [];
    const target = await home('plain', events, { custodianAccountId: 'bob', originalOwnAction: 'agents.models.list',
      ownHttpResponse: { status, body } });

    expect(await dispatchOriginalAccountAction({ actionId: 'agents.models.list', input: ownMachineInput,
      requestId: 'request-1', target: { kind: 'machine', machineId: 'alice-machine' },
      credentials: { token: token(), encryption: null, credentialProvenance: 'stored_session' },
      serverHttpBaseUrl: target.url, serverIdentityId: homeIdentityId,
    })).toEqual({ ok: false, errorCode: expected, error: expected });
    expect(ExternalActionExecutionAuthorizationRequestV1Schema.parse(target.readReceived()).envelope).toMatchObject({
      requestId: 'request-1', target: { kind: 'machine', machineId: 'alice-machine' }, input: ownMachineInput,
    });
    // An uncertain submission is observed, never retried by this reader.
    expect(events).toEqual(['home-authorized', 'dispatch']);
  });

  it.each([
    { localController: false, explicitTarget: true, mode: 'plain' },
    { localController: true, explicitTarget: true, mode: 'plain' },
    { localController: true, explicitTarget: false, mode: 'plain' },
    { localController: true, explicitTarget: false, mode: 'e2ee' },
  ] as const)('carries Home admission for own managed installation retry ($mode, local: $localController, explicit: $explicitTarget)', async ({ localController, explicitTarget, mode }) => {
    await withTempDir('happier-managed-retry-admission-', async taskDir => {
      const originalConfiguration = { serversDir: configuration.serversDir };
      Object.assign(configuration, { serversDir: join(taskDir, 'servers') });
      try {
        const events: string[] = [];
        const refused = { ok: false, errorCode: 'permission_denied', error: 'permission_denied' } as const;
        const target = await home(mode, events, { custodianAccountId: 'bob',
          originalOwnAction: 'machines.managed.bootstrap.retry', ownExecution: refused,
          localDaemon: localController, localDaemonExecution: refused });
        if (localController) {
          const serverDir = join(configuration.serversDir, 'home');
          await mkdir(serverDir, { recursive: true });
          await writeFile(join(serverDir, 'daemon.state.json'), JSON.stringify({ pid: process.pid,
            httpPort: Number(new URL(target.url).port), startedAt: Date.now(), startedWithCliVersion: 'test',
            machineId: 'alice-machine', accountId: 'bob', controlToken: 'test-daemon-control' }));
        }
        const executor = createCliActionExecutorFromCredentials({
          credentials: { token: token(), encryption: mode === 'plain' ? null
            : { type: 'legacy', secret: new Uint8Array(32).fill(23) }, credentialProvenance: 'stored_session' },
          externalActionClient: true, serverId: 'home', serverApiUrl: target.url,
          serverIdentityId: homeIdentityId, ...(explicitTarget ? { machineId: 'alice-machine' } : {}),
          actionsSettingsProvider: { getActionsSettings: () => normalizeActionsSettingsV1({ v: 1 }),
            getAccountSettings: () => accountSettingsParse({}) },
          onRequesterSessionCredentialDisclosure: async () => { throw new Error('Own controller needs no foreign custody'); },
        });
        const input = ManagedMachineActionInputSchemasV1['machines.managed.bootstrap.retry'].parse({
          homeId: homeIdentityId, managedId: 'retained-machine', expectedIntentRevision: 2,
          guestCli: { source: 'home-payload', line: '0.3', channel: 'stable', payloads: [{
            target: { os: 'linux', arch: 'x64' }, sha256: 'a'.repeat(64), url: 'https://requester.example/forged.tar.gz',
          }] },
        });
        const result = await executor.execute('machines.managed.bootstrap.retry', input,
          { surface: 'cli', actionRequestId: 'request-1' });
        expect(result, JSON.stringify(result)).toMatchObject(refused);
        const received = ExternalActionExecutionAuthorizationRequestV1Schema.parse(target.readReceived());
        expect(received.executionAuthorization?.binding).toMatchObject({ accountId: 'bob', custodianAccountId: 'bob',
          machineId: 'alice-machine', installationId: 'alice-installation', actionId: 'machines.managed.bootstrap.retry' });
        expect(received.executionAuthorization?.binding.managedAdmission).toMatchObject({
          input: { guestCli: { payloads: [{ sha256: 'b'.repeat(64), url: '/v1/runtime/guest-cli/payloads/linux/x64' }] } },
        });
        expect(received.executionAuthorization?.binding.requestEnvelopeDigest)
          .toBe(computeExternalActionRequestEnvelopeDigestV1(received.envelope));
        expect(openExternalActionRequesterAccountContextV1({ authorization: received.executionAuthorization,
          purpose: { kind: 'external_action' }, machineId: 'alice-machine', installationId: 'alice-installation',
          serverIdentityId: homeIdentityId, installationPrivateKey: target.privateKey, includeInvocation: true }))
          .toMatchObject({ invocation: { surface: 'cli' } });
        expect(received.envelope.v).toBe(mode === 'plain' ? 1 : 2);
        expect(events).toEqual(['home-authorized', 'dispatch']);
      } finally { Object.assign(configuration, originalConfiguration); }
    });
  });

  it.each([
    { mode: 'plain', method: 'execute' }, { mode: 'e2ee', method: 'execute' },
    { mode: 'plain', method: 'prepare' }, { mode: 'e2ee', method: 'prepare' },
  ] as const)('captures credentials once for an own remote $mode Machine Action ($method)', async ({ mode, method }) => {
    await withTempDir('happier-own-remote-action-', async taskDir => {
      const originalConfiguration = { serversDir: configuration.serversDir };
      Object.assign(configuration, { serversDir: join(taskDir, 'servers') });
      try {
        const events: string[] = [];
        const credentials: StoredCredentials = { token: token('terminal'), encryption: mode === 'plain' ? null
          : { type: 'legacy', secret: new Uint8Array(32).fill(23) }, credentialProvenance: 'stored_session' };
        await writeStoredCredentialsForServerId('home', credentials);
        const credentialFileReads = vi.spyOn(fsPromises, 'readFile');
        const readCredentials = vi.fn(() => readStoredCredentialsForServerId('home'));
        const sentAuthorizations: Array<string | undefined> = [];
        const replacement = { ...credentials, token: token() };
        const target = await home(mode, events, { custodianAccountId: 'bob', originalOwnAction: 'agents.models.list',
          authenticationKind: 'terminal',
          beforeInventoryRead: () => writeStoredCredentialsForServerId('home', replacement),
          onRequestAuthorization: authorization => { sentAuthorizations.push(authorization); } });
        const executor = createCliActionExecutorFromCredentials({ credentials, externalActionClient: true,
          readCredentials,
          serverId: 'home', serverApiUrl: target.url, serverIdentityId: homeIdentityId, machineId: 'alice-machine',
          actionsSettingsProvider: { getActionsSettings: () => normalizeActionsSettingsV1({ v: 1 }) },
          onRequesterSessionCredentialDisclosure: async () => { throw new Error('Own Account work must not disclose private custody'); } });
        const context = { surface: 'cli' as const, actionRequestId: 'request-1' };
        const result = method === 'execute' ? await executor.execute('agents.models.list', ownMachineInput, context)
          : await executor.prepare('agents.models.list', ownMachineInput, context).then(prepared => {
            if (prepared.kind !== 'ready') throw new Error('Expected admitted Machine Action');
            expect(readCredentials).toHaveBeenCalledTimes(1);
            return prepared.invocation.run();
          });
        expect(result).toEqual({ ok: true, result: ownMachineResult });
        expect(readCredentials).toHaveBeenCalledTimes(1);
        expect(credentialFileReads.mock.calls.filter(([path]) => String(path) === join(configuration.serversDir, 'home', 'access.key')))
          .toHaveLength(1);
        expect(sentAuthorizations.length).toBeGreaterThan(0);
        expect(sentAuthorizations.every(value => value === `Bearer ${credentials.token}`)).toBe(true);
        const received = ExternalActionExecutionAuthorizationRequestV1Schema.parse(target.readReceived()).envelope;
        expect(received.target).toEqual({ kind: 'machine', machineId: 'alice-machine' });
        expect(received.v).toBe(mode === 'plain' ? 1 : 2);
        expect(events).toEqual(['home-authorized', 'dispatch']);
        expect(JSON.stringify(received)).not.toContain(credentials.token);
      } finally { Object.assign(configuration, originalConfiguration); }
    });
  });

  it.each([
    { separateHome: false, legacy: false, legacyState: false },
    { separateHome: true, legacy: false, legacyState: false },
    { separateHome: true, legacy: true, legacyState: false },
    { separateHome: true, legacy: true, legacyState: true },
  ])('requires Home admission for Machine observations even beside a matching local endpoint (separate Home: $separateHome, legacy: $legacy, legacy state: $legacyState)', async ({ separateHome, legacy, legacyState }) => {
    await withTempDir('happier-own-local-action-', async taskDir => {
      const originalConfiguration = { serversDir: configuration.serversDir };
      Object.assign(configuration, { serversDir: join(taskDir, 'servers') });
      try {
        const events: string[] = [];
        const target = await home('plain', events, { custodianAccountId: 'bob', originalOwnAction: 'agents.models.list', localDaemon: true });
        const control = separateHome ? await home('plain', events, { custodianAccountId: 'bob', localDaemon: true }) : target;
        const serverDir = join(configuration.serversDir, 'home');
        await mkdir(serverDir, { recursive: true });
        await writeFile(join(serverDir, 'daemon.state.json'), JSON.stringify(legacyState
          ? { pid: process.pid, httpPort: Number(new URL(control.url).port), startTime: new Date().toISOString(), startedWithCliVersion: 'test' }
          : { pid: process.pid, httpPort: Number(new URL(control.url).port), startedAt: Date.now(), startedWithCliVersion: 'test',
            machineId: 'alice-machine', accountId: 'bob', controlToken: 'test-daemon-control' }));
        const executor = createCliActionExecutorFromCredentials({
          credentials: { token: legacy ? `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: 'bob' })).toString('base64url')}.signature` : token(),
            encryption: null, credentialProvenance: 'stored_session' }, externalActionClient: true,
          serverId: 'home', serverApiUrl: target.url, serverIdentityId: homeIdentityId, machineId: 'alice-machine',
          actionsSettingsProvider: { getActionsSettings: () => normalizeActionsSettingsV1({ v: 1 }) },
        });
        const result = await executor.execute('agents.models.list', ownMachineInput, { surface: 'cli', actionRequestId: 'request-1' });
        if (legacy) {
          expect(result).toMatchObject({ ok: false, errorCode: 'admission_unavailable', error: 'admission_unavailable',
            effectAttempted: false, failureCause: { errorCode: 'admission_unavailable', phase: 'dispatch.requester_authentication' } });
          expect(target.readReceived()).toBeUndefined();
        } else expect(result).toEqual({ ok: true, result: ownMachineResult });
        expect(events).toEqual(legacy ? [] : ['home-authorized', 'dispatch']);
        if (separateHome) expect(control.readReceived()).toBeUndefined();
        if (!legacy) expect(ExternalActionExecutionAuthorizationRequestV1Schema.parse(target.readReceived()).executionAuthorization?.binding)
          .toMatchObject({ actionId: 'agents.models.list', machineId: 'alice-machine' });
      } finally { Object.assign(configuration, originalConfiguration); }
    });
  });

  it.each(['account', 'terminal'] as const)('keeps own %s automation authority and propagates the Home refusal without a local daemon fallback', async authenticationKind => {
    await withTempDir('happier-own-remote-refusal-', async taskDir => {
      const originalConfiguration = { serversDir: configuration.serversDir };
      Object.assign(configuration, { serversDir: join(taskDir, 'servers') });
      try {
        const events: string[] = [];
        const target = await home('plain', events, { custodianAccountId: 'bob', originalOwnAction: 'agents.models.list',
          authenticationKind, authorityCeiling: 'account_automation', ownExecution: { ok: false, errorCode: 'action_disabled', error: 'action_disabled' } });
        const executor = createCliActionExecutorFromCredentials({
          credentials: { token: token(authenticationKind), encryption: null, credentialProvenance: 'stored_session' }, externalActionClient: true,
          serverId: 'home', serverApiUrl: target.url, serverIdentityId: homeIdentityId, machineId: 'alice-machine',
          actionsSettingsProvider: { getActionsSettings: () => normalizeActionsSettingsV1({ v: 1 }) },
        });
        await expect(executor.execute('agents.models.list', ownMachineInput, { surface: 'cli', authority: 'account_automation', actionRequestId: 'request-1' }))
          .resolves.toMatchObject({ ok: false, errorCode: 'action_disabled' });
        expect(events).toEqual(['home-authorized', 'dispatch']);
      } finally { Object.assign(configuration, originalConfiguration); }
    });
  });

  it.each([
    { placement: 'machine', localDaemon: true },
    { placement: 'account-default', localDaemon: true },
    { placement: 'session', localDaemon: true },
    { placement: 'account-default', localDaemon: false },
    { placement: 'session', localDaemon: false },
  ] as const)('keeps private local control separate from Home credential retirement on $placement delivery (private daemon: $localDaemon)', async ({ placement, localDaemon }) => {
    await withTempDir('happier-terminal-own-local-', async taskDir => {
      const originalConfiguration = { serversDir: configuration.serversDir };
      Object.assign(configuration, { serversDir: join(taskDir, 'servers') });
      try {
        const events: string[] = [];
        const target = await home('plain', events, { custodianAccountId: 'bob', originalOwnAction: 'machines.work.summary.get',
          authenticationKind: 'terminal', retireOwnAction: true, retireAccountSecurity: placement === 'account-default',
          retireSessionAccess: placement === 'session' });
        const control = !localDaemon ? null : placement === 'machine'
          ? await home('plain', events, { custodianAccountId: 'bob', localDaemon: true })
          : await privateAccountDaemon(target.url, events);
        const serverDir = join(configuration.serversDir, 'home');
        if (control) {
          await mkdir(serverDir, { recursive: true });
          await writeFile(join(serverDir, 'daemon.state.json'), JSON.stringify({ pid: process.pid,
            httpPort: Number(new URL(control.url).port), startedAt: Date.now(), startedWithCliVersion: 'test',
            machineId: 'alice-machine', accountId: 'bob', controlToken: 'test-daemon-control' }));
        }
        const executor = createCliActionExecutorFromCredentials({
          credentials: { token: token('terminal'), encryption: null, credentialProvenance: 'stored_session' }, externalActionClient: true,
          serverId: 'home', serverApiUrl: target.url, serverIdentityId: homeIdentityId,
          ...(placement === 'machine' ? { machineId: 'alice-machine' } : {}),
          actionsSettingsProvider: { getActionsSettings: () => normalizeActionsSettingsV1({ v: 1 }) },
          onRequesterSessionCredentialDisclosure: async () => { throw new Error('Own terminal origination must not disclose full Account custody'); },
        });
        const input = placement === 'machine' ? { serverId: 'home', machineId: 'alice-machine' } : placement === 'session' ? { sessionId: 'session-1' } : {};
        // Session access is server-placed: its input selects the resource;
        // an outer Session target would instead request runner placement.
        const context = { surface: 'cli' as const, actionRequestId: 'request-1' };
        const result = await executor.execute(placement === 'machine' ? 'machines.work.summary.get'
          : placement === 'session' ? 'session.access.grants.list' : 'account.security.get', input, context);
        if (placement === 'machine') {
          expect(result).toMatchObject({ ok: false, errorCode: 'invalid_token' });
          expect(events).toEqual(['home-authorized', 'dispatch']);
          expect(target.readRetiredRequests()).toEqual([expect.objectContaining({ authorization: `Bearer ${token('terminal')}` })]);
          expect(control?.readReceived()).toBeUndefined();
          return;
        }
        expect(result).toMatchObject({ ok: false, errorCode: 'not_authenticated' });
        const homeEvent = placement === 'session' ? 'session-access' : 'account-security';
        expect(events).toEqual(control ? ['local-daemon', homeEvent] : [homeEvent]);
        expect(target.readRetiredRequests()).toEqual([expect.objectContaining({ authorization: `Bearer ${token(control ? 'account' : 'terminal')}`,
          ...(placement === 'session' ? { path: '/v2/sessions/access-grants/list', body: { sessionId: 'session-1' } } : {}) })]);
        if (control) {
          expect(control.readReceived()).toMatchObject({ actionId: placement === 'session' ? 'session.access.grants.list' : 'account.security.get' });
          expect(JSON.stringify(control.readReceived())).not.toContain(token('terminal'));
        }
      } finally { Object.assign(configuration, originalConfiguration); }
    });
  });

  // docs/actions.md, "The three host-stamped facts": terminal CLI/RPC
  // invocations are present-user. External delivery does not change the surface;
  // an explicit per-invocation automation ceiling still narrows it.
  it.each([
    { externalClient: true, authority: undefined, expected: 'present_user' },
    { externalClient: false, authority: undefined, expected: 'present_user' },
    { externalClient: true, authority: 'account_automation', expected: 'account_automation' },
  ] as const)('preserves terminal person authority and explicit attribution on CLI delivery ($externalClient, $authority)', async ({ externalClient, authority, expected }) => {
    expect(effectiveCredentialAuthority({ credentialKind: 'terminal', mintedAuthority: 'account_automation' })).toBe('present_user');
    const target = await home('plain', [], { custodianAccountId: 'bob', allowedTerminalSecurity: true });
    const executor = createCliActionExecutorFromCredentials({ credentials: {
      token: token('terminal'), encryption: null, credentialProvenance: 'stored_session',
    }, ...(externalClient ? { externalActionClient: true as const } : {}),
      serverId: 'home', serverApiUrl: target.url, serverIdentityId: homeIdentityId,
      actionsSettingsProvider: { getActionsSettings: () => normalizeActionsSettingsV1({ v: 1 }) },
    });
    await expect(executor.execute('account.security.get', {}, { surface: 'cli', actionRequestId: 'terminal-ceiling',
      ...(authority ? { authority } : {}) }))
      .resolves.toMatchObject({ ok: true, result: { encryptionMode: 'plain' } });
    expect(target.readSecurityPrincipals()).toEqual([{ authority: expected,
      authorization: `Bearer ${token('terminal')}` }]);
  });

  it.each(['legacy', 'modern'] as const)('keeps Bob foreign Home admission and private custody despite a live Alice local publication (%s)', async publication => {
    await withTempDir('happier-foreign-legacy-publication-', async taskDir => {
      const originalConfiguration = { serversDir: configuration.serversDir };
      Object.assign(configuration, { serversDir: join(taskDir, 'servers') });
      try {
        const events: string[] = [];
        const target = await home('plain', events);
        const control = await home('plain', events, { localDaemon: true,
          localDaemonExecution: { ok: false, errorCode: 'ambient_daemon_receipt', error: 'ambient_daemon_receipt' } });
        const serverDir = join(configuration.serversDir, 'home');
        await mkdir(serverDir, { recursive: true });
        await writeFile(join(serverDir, 'daemon.state.json'), JSON.stringify(publication === 'legacy'
          ? { pid: process.pid, httpPort: Number(new URL(control.url).port), startTime: new Date().toISOString(), startedWithCliVersion: 'test' }
          : { pid: process.pid, httpPort: Number(new URL(control.url).port), startedAt: Date.now(), startedWithCliVersion: 'test',
            machineId: 'alice-machine', accountId: 'alice', controlToken: 'test-daemon-control' }));
        const credentials: StoredCredentials = { token: token(), encryption: null, credentialProvenance: 'stored_session' };
        const executor = createCliActionExecutorFromCredentials({ credentials, externalActionClient: true,
          serverId: 'home', serverApiUrl: target.url, serverIdentityId: homeIdentityId, machineId: 'alice-machine',
          actionsSettingsProvider: { getActionsSettings: () => normalizeActionsSettingsV1({ v: 1 }) },
          onRequesterSessionCredentialDisclosure: async () => { events.push('disclosed'); return true; } });
        await expect(executor.execute('agents.models.list', ownMachineInput,
          { surface: 'cli', actionRequestId: 'request-1' })).resolves.toMatchObject({ errorCode: 'fixture_receipt' });
        const received = ExternalActionExecutionAuthorizationRequestV1Schema.parse(target.readReceived());
        expect(openExternalActionRequesterAccountContextV1({ authorization: received.executionAuthorization,
          purpose: { kind: 'external_action' }, machineId: 'alice-machine', installationId: 'alice-installation',
          serverIdentityId: homeIdentityId, installationPrivateKey: target.privateKey })).toEqual(encodeStoredCredentials(credentials));
        expect(events).not.toContain('local-daemon');
        expect(events.indexOf('disclosed')).toBeLessThan(events.indexOf('dispatch'));
      } finally { Object.assign(configuration, originalConfiguration); }
    });
  });

  it.each([true, false])('reads one exact host-facts row for Machine admission (foreign shortcut: %s)', async foreignTargetOnly => {
    const events: string[] = [];
    const inventoryResponses: Array<Readonly<{ path: string; rows: number }>> = [];
    const actionId = foreignTargetOnly ? 'settings.list' : 'agents.models.list';
    const target = await home('plain', events, { custodianAccountId: 'bob', originalOwnAction: actionId,
      malformedUnrelatedMachine: true,
      onInventoryResponse: (path, rows) => { inventoryResponses.push({ path, rows }); } });
    const result = await dispatchOriginalAccountAction({ actionId, input: foreignTargetOnly ? {} : ownMachineInput,
      requestId: 'request-1', target: { kind: 'machine', machineId: 'alice-machine' },
      credentials: { token: token(), encryption: null }, serverHttpBaseUrl: target.url,
      serverIdentityId: homeIdentityId, ...(foreignTargetOnly ? { foreignTargetOnly: true as const } : {}) });
    expect(inventoryResponses).toEqual([{ path: '/v1/machines/alice-machine', rows: 1 }]);
    if (foreignTargetOnly) {
      expect(result).toBeNull();
      expect(events).toEqual([]);
    } else {
      expect(result).toMatchObject({ ok: true, result: ownMachineResult });
      expect(events).toEqual(['home-authorized', 'dispatch']);
    }
  });

  it('admits a proposed preset Plan at Home even beside the selected Machine daemon', async () => {
    await withTempDir('happier-own-preset-plan-', async taskDir => {
      const originalConfiguration = { serversDir: configuration.serversDir };
      Object.assign(configuration, { serversDir: join(taskDir, 'servers') });
      try {
        const events: string[] = [];
        const actionId = 'machines.setup.plan';
        const machineId = 'alice-machine';
        const address = { homeId: homeIdentityId, machineId };
        const sources = [{ kind: 'accountPresetOpaque', presetId: 'saved', presetRevision: 1, contentEncryptionMode: 'plain' },
          { kind: 'direct', setup: {} }];
        const storedPlan = { desiredRevision: 2, sources: [], exclusions: [], support: [] };
        const proposedPlan = { ...storedPlan, sources };
        const target = await home('plain', events, { custodianAccountId: 'bob', originalOwnAction: actionId,
          machineRole: 'manage', localDaemon: true, localDaemonExecution: { ok: true, result: storedPlan },
          ownExecution: { ok: true, result: proposedPlan } });
        const serverDir = join(configuration.serversDir, 'home');
        await mkdir(serverDir, { recursive: true });
        await writeFile(join(serverDir, 'daemon.state.json'), JSON.stringify({ pid: process.pid,
          httpPort: Number(new URL(target.url).port), startedAt: Date.now(), startedWithCliVersion: 'test',
          machineId, accountId: 'bob', controlToken: 'test-daemon-control' }));
        const credentials: StoredCredentials = { token: token(), encryption: null, credentialProvenance: 'stored_session' };
        async function invoke(input: unknown) {
          const output = captureConsoleJsonOutput();
          try {
            await handleActionsCommand(['invoke', actionId, '--machine-id', machineId, '--request-id', 'request-1',
              '--input-json', JSON.stringify(input), '--json'], {
              readCredentialsFn: async () => credentials,
              createExecutorFn: params => createCliActionExecutorFromCredentials({ ...params,
                serverId: 'home', serverApiUrl: target.url, serverIdentityId: homeIdentityId,
                actionsSettingsProvider: { getActionsSettings: () => normalizeActionsSettingsV1({ v: 1 }) } }),
            });
            return output.json();
          } finally { output.restore(); }
        }
        expect(await invoke(address)).toMatchObject({ ok: true, data: storedPlan });
        expect(events).toEqual(['local-daemon']);
        events.length = 0;
        const input = { ...address, mode: 'effects', sources };
        expect(await invoke(input)).toMatchObject({ ok: true, data: proposedPlan });
        expect(events).toEqual(['home-authorized', 'dispatch']);
        expect(ExternalActionExecutionAuthorizationRequestV1Schema.parse(target.readReceived())).toMatchObject({
          envelope: { input }, executionAuthorization: { binding: { actionId, machineId, installationId: 'alice-installation' } },
        });
      } finally { Object.assign(configuration, originalConfiguration); }
    });
  });

  it('overlaps passive Home mode and inventory reads but joins both before authorization or dispatch', async () => {
    const events: string[] = [];
    const measured = await home('plain', [], { custodianAccountId: 'bob', originalOwnAction: 'agents.models.list', passiveReadDelayMs: 20 });
    const request = { actionId: 'agents.models.list', input: ownMachineInput,
      requestId: 'request-1', target: { kind: 'machine', machineId: 'alice-machine' } as const,
      credentials: { token: token(), encryption: null }, serverIdentityId: homeIdentityId };
    await dispatchOriginalAccountAction({ ...request, serverHttpBaseUrl: measured.url });
    for (let sample = 0; sample < 3; sample++) {
      expect(await dispatchOriginalAccountAction({ ...request, serverHttpBaseUrl: measured.url })).toMatchObject({ ok: true, result: ownMachineResult });
    }
    let releaseMode!: () => void;
    let inventoryRead = false;
    const modeGate = new Promise<void>(resolve => { releaseMode = resolve; });
    const target = await home('plain', events, { custodianAccountId: 'bob', originalOwnAction: 'agents.models.list',
      beforeEncryptionRead: () => modeGate, onInventoryRead: () => { inventoryRead = true; } });
    const pending = dispatchOriginalAccountAction({ actionId: 'agents.models.list', input: ownMachineInput,
      requestId: 'request-1', target: { kind: 'machine', machineId: 'alice-machine' },
      credentials: { token: token(), encryption: null }, serverHttpBaseUrl: target.url, serverIdentityId: homeIdentityId });
    try {
      await vi.waitFor(() => expect(inventoryRead).toBe(true));
      expect(events).toEqual([]);
      expect(target.readReceived()).toBeUndefined();
    } finally {
      releaseMode();
      await expect(pending).resolves.toMatchObject({ ok: true, result: ownMachineResult });
    }
  });

  it('preserves mode refusal when concurrent inventory also fails, without minting or dispatching', async () => {
    const events: string[] = [];
    const target = await home('plain', events, { invalidEncryptionResponse: true, inventoryUnavailable: true });
    expect(await dispatchOriginalAccountAction({ actionId: 'agents.models.list', input: ownMachineInput,
      requestId: 'request-1', target: { kind: 'machine', machineId: 'alice-machine' },
      credentials: { token: token(), encryption: null }, serverHttpBaseUrl: target.url, serverIdentityId: homeIdentityId }))
      .toMatchObject({ ok: false, errorCode: 'content_unavailable' });
    expect(events).toEqual([]);
    expect(target.readReceived()).toBeUndefined();
  });

  it('joins the one Machine publication read and validates its custody before disclosure', async () => {
    const request = { actionId: 'agents.models.list', input: ownMachineInput,
      requestId: 'request-1', target: { kind: 'machine', machineId: 'alice-machine' } as const,
      credentials: { token: token(), encryption: null }, serverIdentityId: homeIdentityId };
    const events: string[] = [];
    let releaseInventory!: () => void;
    const inventoryGate = new Promise<void>(resolve => { releaseInventory = resolve; });
    let publicationRead = false;
    const target = await home('plain', events, { originalOwnAction: 'agents.models.list',
      beforeInventoryRead: () => inventoryGate, onInstalledMachineRead: () => { publicationRead = true; } });
    const pending = dispatchOriginalAccountAction({ ...request, serverHttpBaseUrl: target.url,
      onRequesterSessionCredentialDisclosure: async () => { events.push('disclosed'); return true; } });
    try {
      await vi.waitFor(() => expect(publicationRead).toBe(true));
      expect(events).toEqual([]);
      expect(target.readReceived()).toBeUndefined();
    } finally {
      releaseInventory();
      await expect(pending).resolves.toMatchObject({ ok: true, result: ownMachineResult });
    }
    const mismatchEvents: string[] = [];
    const mismatch = await home('plain', mismatchEvents, { installedCustodianAccountId: 'replacement-owner' });
    expect(await dispatchOriginalAccountAction({ ...request, serverHttpBaseUrl: mismatch.url,
      onRequesterSessionCredentialDisclosure: async () => { mismatchEvents.push('disclosed'); return true; } }))
      .toMatchObject({ ok: false, errorCode: 'admission_unavailable' });
    // Inventory and installation share one publication, so a replaced custodian is
    // caught against the Home-minted binding: nothing is disclosed or dispatched.
    expect(mismatchEvents).toEqual(['home-authorized']);
    expect(mismatch.readReceived()).toBeUndefined();
  });

  it('cancels own remote origination during Home inventory before disclosure or dispatch', async () => {
    await withTempDir('happier-own-remote-cancel-', async taskDir => {
      const originalConfiguration = { serversDir: configuration.serversDir };
      Object.assign(configuration, { serversDir: join(taskDir, 'servers') });
      try {
        const events: string[] = [];
        const controller = new AbortController();
        const target = await home('plain', events, { custodianAccountId: 'bob', originalOwnAction: 'agents.models.list',
          onInventoryRead: () => controller.abort() });
        const executor = createCliActionExecutorFromCredentials({
          credentials: { token: token(), encryption: null, credentialProvenance: 'stored_session' }, externalActionClient: true,
          serverId: 'home', serverApiUrl: target.url, serverIdentityId: homeIdentityId, machineId: 'alice-machine',
          actionsSettingsProvider: { getActionsSettings: () => normalizeActionsSettingsV1({ v: 1 }) },
        });
        await expect(executor.execute('agents.models.list', ownMachineInput, { surface: 'cli', actionRequestId: 'request-1', signal: controller.signal }))
          .resolves.toMatchObject({ ok: false, errorCode: 'cancelled' });
        expect(events).toEqual([]);
        expect(target.readReceived()).toBeUndefined();
      } finally { Object.assign(configuration, originalConfiguration); }
    });
  });

  it('refuses own E2EE remote work without Account material rather than inventing a plain request', async () => {
    const events: string[] = [];
    const target = await home('e2ee', events, { custodianAccountId: 'bob', originalOwnAction: 'settings.list' });
    const result = await dispatchOriginalAccountAction({ actionId: 'settings.list', input: {}, requestId: 'request-1',
      target: { kind: 'machine', machineId: 'alice-machine' }, credentials: { token: token(), encryption: null },
      serverHttpBaseUrl: target.url, serverIdentityId: homeIdentityId });
    expect(result).toMatchObject({ ok: false, errorCode: 'content_unavailable' });
    expect(events).toEqual([]);
    expect(target.readReceived()).toBeUndefined();
  });

  it.each(['plain', 'e2ee'] as const)('discloses then delivers genuine %s Bob material sealed to the exact Home root and installation', async mode => {
    const events: string[] = [];
    const target = await home(mode, events);
    const credentials: StoredCredentials = { token: token(), encryption: mode === 'plain' ? null : { type: 'legacy', secret: new Uint8Array(32).fill(23) } };
    const disclosure = { onRequesterSessionCredentialDisclosure: async (value: ReturnType<typeof projectRequesterSessionCredentialDisclosure>) => {
      expect(value).toMatchObject({ accountId: 'bob', machineId: 'alice-machine', fullSignIn: true, hostCanInspectLocalProcess: true });
      expect(target.readReceived()).toBeUndefined();
      events.push('disclosed');
      return true;
    } };
    await expect(dispatchOriginalAccountAction({ actionId: 'agents.models.list', input: ownMachineInput,
      requestId: 'request-1', target: { kind: 'machine', machineId: 'alice-machine' }, credentials,
      serverHttpBaseUrl: target.url, serverIdentityId: homeIdentityId, ...disclosure })).resolves.toMatchObject({ errorCode: 'fixture_receipt' });
    const received = ExternalActionExecutionAuthorizationRequestV1Schema.parse(target.readReceived());
    expect(events.indexOf('disclosed')).toBeLessThan(events.indexOf('dispatch'));
    expect(received.executionAuthorization?.requesterAccountContext?.installationId).toBe('alice-installation');
    const opening = { authorization: received.executionAuthorization, purpose: { kind: 'external_action' as const },
      machineId: 'alice-machine', installationId: 'alice-installation', serverIdentityId: homeIdentityId, installationPrivateKey: target.privateKey };
    expect(openExternalActionRequesterAccountContextV1(opening)).toEqual(encodeStoredCredentials(credentials));
    expect(openExternalActionRequesterAccountContextV1({ ...opening, purpose: { kind: 'machine_rpc', method: 'other', params: {} } })).toBeNull();
    expect(JSON.stringify(received)).not.toContain(credentials.token);
  });

  it.each(['plain', 'e2ee'] as const)('asks once before disclosing credentials for one contributed Machine Action invocation (%s)', async mode => {
    const events: string[] = [];
    const paths: (string | undefined)[] = [];
    const target = await home(mode, events, { originalOwnAction: 'action.invoke', machineRole: 'manage',
      onRequestPath: path => paths.push(path),
      ownExecution: { ok: true, result: { configured: true } } });
    const credentials: StoredCredentials = { token: token(), encryption: mode === 'plain' ? null
      : { type: 'legacy', secret: new Uint8Array(32).fill(23) }, credentialProvenance: 'stored_session' };
    terminal.interactive = true;
    terminal.answer = 'y';
    const output = captureConsoleText();
    try {
      await handleActionsCommand(['invoke', 'action.invoke', '--machine-id', 'alice-machine', '--request-id', 'request-1',
        '--input-json', JSON.stringify({ action: { pluginId: 'happier.machine.services', localId: 'machine-online/setup' },
          input: { v: 1, serverId: homeIdentityId, machineId: 'alice-machine' } }), '--yes'], {
        readCredentialsFn: async () => credentials,
        createExecutorFn: params => createCliActionExecutorFromCredentials({ ...params,
          serverId: 'home', serverApiUrl: target.url, serverIdentityId: homeIdentityId,
          actionsSettingsProvider: { getActionsSettings: () => normalizeActionsSettingsV1({ v: 1 }) } }),
      });
      expect(terminal.prompts, JSON.stringify({ events, paths })).toHaveLength(1);
      expect(output.text()).toContain('configured');
    } finally { output.restore(); }
  });

  it.each(['plain', 'e2ee'] as const)('refuses a Can-use contributed invocation before disclosing credentials (%s)', async mode => {
    const events: string[] = [];
    const target = await home(mode, events, { originalOwnAction: 'action.invoke', contributedInvocationDenied: true });
    const credentials: StoredCredentials = { token: token(), encryption: mode === 'plain' ? null
      : { type: 'legacy', secret: new Uint8Array(32).fill(23) }, credentialProvenance: 'stored_session' };
    terminal.interactive = true;
    terminal.answer = 'y';
    const output = captureConsoleText();
    try {
      await handleActionsCommand(['invoke', 'action.invoke', '--machine-id', 'alice-machine', '--request-id', 'request-1',
        '--input-json', JSON.stringify({ action: { pluginId: 'happier.machine.services', localId: 'machine-online/setup' },
          input: { v: 1, serverId: homeIdentityId, machineId: 'alice-machine' } }), '--yes'], {
        readCredentialsFn: async () => credentials,
        createExecutorFn: params => createCliActionExecutorFromCredentials({ ...params,
          serverId: 'home', serverApiUrl: target.url, serverIdentityId: homeIdentityId,
          actionsSettingsProvider: { getActionsSettings: () => normalizeActionsSettingsV1({ v: 1 }) } }),
      });
      expect(terminal.prompts, JSON.stringify({ events, output: output.text() })).toHaveLength(0);
      expect(output.text()).toContain('needs Manage on this Machine');
      expect(events).not.toContain('dispatch');
      expect(target.readReceived()).toBeUndefined();
    } finally { output.restore(); }
  });

  it('still requires guest disclosure for an Action that carries requester credentials', async () => {
    const events: string[] = [];
    const target = await home('plain', events);
    const executor = createCliActionExecutorFromCredentials({
      credentials: { token: token(), encryption: null, credentialProvenance: 'stored_session' }, externalActionClient: true,
      serverId: 'home', serverApiUrl: target.url, serverIdentityId: homeIdentityId, machineId: 'alice-machine',
      actionsSettingsProvider: { getActionsSettings: () => normalizeActionsSettingsV1({ v: 1 }) },
      onRequesterSessionCredentialDisclosure: async () => { events.push('disclosed'); return false; },
    });
    await expect(executor.execute('agents.models.list', ownMachineInput,
      { surface: 'cli', actionRequestId: 'request-1' })).resolves.toMatchObject({
      ok: false, errorCode: 'requester_credential_disclosure_declined',
    });
    expect(events).toContain('disclosed');
    expect(events).not.toContain('dispatch');
    expect(target.readReceived()).toBeUndefined();
  });

  it.each([
    { actionId: 'machines.agents.install.status' as const, input: { machineId: 'alice-machine', jobId: 'job' },
      result: PUBLIC_ACTION_OUTPUT_SCHEMAS['machines.agents.install.status'].parse({
        ok: true, steps: [], progress: [], events: [], nextCursor: 0, done: false, outcome: null }) },
    { actionId: 'machines.agents.install.cancel' as const, input: { machineId: 'alice-machine', jobId: 'job' },
      result: PUBLIC_ACTION_OUTPUT_SCHEMAS['machines.agents.install.cancel'].parse({ ok: true }) },
    { actionId: 'machines.work.summary.get' as const, input: { serverId: homeIdentityId, machineId: 'alice-machine' },
      result: { kind: 'current', requesters: [] } },
    { actionId: 'machines.agents.signIn.status' as const, input: { machineId: 'alice-machine', agentId: 'codex' },
      result: { status: 'signedIn', checkedAt: 1, nativeLogin: 'status_only', connectedServices: [], signInScope: 'machineOwner' } },
    { actionId: 'machines.agents.list' as const, input: { machineId: 'alice-machine' }, result: { items: [] } },
  ].flatMap(read => (['plain', 'e2ee'] as const).flatMap(mode => [false, true].map(disclosureCallback => ({ ...read, mode, disclosureCallback })))))('delivers the identity-free $actionId read without requester credential disclosure ($mode, callback: $disclosureCallback)', async ({ actionId, input, result, mode, disclosureCallback }) => {
    const events: string[] = [];
    const execution = { ok: true as const, result };
    const target = await home(mode, events, { originalOwnAction: actionId, ownExecution: execution, machineRole: 'manage' });
    const credentials: StoredCredentials = { token: token(), encryption: mode === 'plain' ? null
      : { type: 'legacy', secret: new Uint8Array(32).fill(23) }, credentialProvenance: 'stored_session' };
    const executor = createCliActionExecutorFromCredentials({ credentials, externalActionClient: true,
      serverId: 'home', serverApiUrl: target.url, serverIdentityId: homeIdentityId, machineId: 'alice-machine',
      actionsSettingsProvider: { getActionsSettings: () => normalizeActionsSettingsV1({ v: 1 }) },
      ...(disclosureCallback ? { onRequesterSessionCredentialDisclosure: async () => { events.push('disclosed'); return false; } } : {}) });
    // Cancellation approval is independent of credential transport. Enter its
    // existing signed carrier directly; read cases exercise the public factory.
    const delivered = actionId === 'machines.agents.install.cancel'
      ? dispatchOriginalAccountAction({ actionId, input, requestId: 'request-1',
        target: { kind: 'machine', machineId: 'alice-machine' }, credentials,
        serverHttpBaseUrl: target.url, serverIdentityId: homeIdentityId,
        ...(disclosureCallback ? { onRequesterSessionCredentialDisclosure: async () => { events.push('disclosed'); return false; } } : {}) })
      : executor.execute(actionId, input, { surface: 'cli', actionRequestId: 'request-1' });
    await expect(delivered).resolves.toEqual(execution);
    const received = ExternalActionExecutionAuthorizationRequestV1Schema.parse(target.readReceived());
    expect(received.executionAuthorization?.binding).toMatchObject({ accountId: 'bob', machineId: 'alice-machine', actionId });
    const opening = { authorization: received.executionAuthorization, machineId: 'alice-machine',
      installationId: 'alice-installation', serverIdentityId: homeIdentityId, installationPrivateKey: target.privateKey };
    const codec = openManagedControllerActionCodecV1(opening);
    expect(codec).not.toBeNull();
    if (mode === 'e2ee') {
      expect(received.envelope.v).toBe(2);
      if (received.envelope.v !== 2 || !codec) throw new Error('Expected encrypted read and invocation codec');
      expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: received.envelope, material: codec,
        binding: { serverIdentityId: homeIdentityId, accountId: 'bob', authentication: { kind: 'account', tokenEpoch: 7 },
          actionId, requestId: 'request-1', target: { kind: 'machine', machineId: 'alice-machine' } } })?.input).toEqual(input);
      expect(codec.machineKey).not.toEqual(deriveAccountMachineKeyFromRecoverySecret(new Uint8Array(32).fill(23)));
    }
    expect(openExternalActionRequesterAccountContextV1({ ...opening, purpose: { kind: 'external_action' } })).toBeNull();
    expect(events).not.toContain('disclosed');
    expect(JSON.stringify(received)).not.toContain(credentials.token);
  });

  it('originates the same private carrier through the ordinary public CLI factory without a local daemon', async () => {
    const events: string[] = [];
    const target = await home('plain', events);
    const credentials: StoredCredentials = { token: token(), encryption: null, credentialProvenance: 'stored_session' };
    const executor = createCliActionExecutorFromCredentials({ credentials, externalActionClient: true,
      serverId: 'home', serverApiUrl: target.url, serverIdentityId: homeIdentityId, machineId: 'alice-machine',
      actionsSettingsProvider: { getActionsSettings: () => normalizeActionsSettingsV1({ v: 1 }) },
      ...{ onRequesterSessionCredentialDisclosure: async () => { events.push('disclosed'); return true; } } });
    await expect(executor.execute('agents.models.list', ownMachineInput,
      { surface: 'cli', actionRequestId: 'request-1' })).resolves.toMatchObject({ errorCode: 'fixture_receipt' });
    const received = ExternalActionExecutionAuthorizationRequestV1Schema.parse(target.readReceived());
    expect(openExternalActionRequesterAccountContextV1({ authorization: received.executionAuthorization,
      purpose: { kind: 'external_action' }, machineId: 'alice-machine', installationId: 'alice-installation',
      serverIdentityId: homeIdentityId, installationPrivateKey: target.privateKey })).toEqual(encodeStoredCredentials(credentials));
  });

  it.each(['plain', 'e2ee'] as const)('keeps genuine terminal kind and automation ceiling through %s private Account custody', async mode => {
    const events: string[] = [];
    const target = await home(mode, events, { authenticationKind: 'terminal' });
    const credentials: StoredCredentials = { token: token('terminal'),
      encryption: mode === 'plain' ? null : { type: 'legacy', secret: new Uint8Array(32).fill(23) } };
    const result = await dispatchOriginalAccountAction({ actionId: 'agents.models.list',
      input: ownMachineInput, requestId: 'request-1',
      target: { kind: 'machine', machineId: 'alice-machine' }, credentials,
      serverHttpBaseUrl: target.url, serverIdentityId: homeIdentityId, authority: 'account_automation',
      onRequesterSessionCredentialDisclosure: async () => { events.push('disclosed'); return true; } });
    expect(result).toMatchObject({ errorCode: 'fixture_receipt' });
    const received = ExternalActionExecutionAuthorizationRequestV1Schema.parse(target.readReceived());
    expect(received.executionAuthorization?.binding).toMatchObject({ accountId: 'bob',
      authentication: { kind: 'terminal', tokenEpoch: 7 } });
    expect(openExternalActionRequesterAccountContextV1({ authorization: received.executionAuthorization,
      purpose: { kind: 'external_action' }, machineId: 'alice-machine', installationId: 'alice-installation',
      serverIdentityId: homeIdentityId, installationPrivateKey: target.privateKey })).toEqual(encodeStoredCredentials(credentials));
    expect(events.indexOf('disclosed')).toBeLessThan(events.indexOf('dispatch'));
  });

  it('originates genuine terminal private custody through the public CLI factory without a human upgrade', async () => {
    const events: string[] = [];
    const target = await home('plain', events, { authenticationKind: 'terminal' });
    const credentials: StoredCredentials = { token: token('terminal'), encryption: null, credentialProvenance: 'stored_session' };
    const executor = createCliActionExecutorFromCredentials({ credentials, externalActionClient: true,
      serverId: 'home', serverApiUrl: target.url, serverIdentityId: homeIdentityId, machineId: 'alice-machine',
      actionsSettingsProvider: { getActionsSettings: () => normalizeActionsSettingsV1({ v: 1 }) },
      onRequesterSessionCredentialDisclosure: async () => true });
    await expect(executor.execute('agents.models.list', ownMachineInput,
      { surface: 'cli', authority: 'account_automation', actionRequestId: 'request-1' })).resolves.toMatchObject({ errorCode: 'fixture_receipt' });
    const received = ExternalActionExecutionAuthorizationRequestV1Schema.parse(target.readReceived());
    expect(received.executionAuthorization?.binding).toMatchObject({ authentication: { kind: 'terminal', tokenEpoch: 7 } });
    expect(openExternalActionRequesterAccountContextV1({ authorization: received.executionAuthorization,
      purpose: { kind: 'external_action' }, machineId: 'alice-machine', installationId: 'alice-installation',
      serverIdentityId: homeIdentityId, installationPrivateKey: target.privateKey })).toEqual(encodeStoredCredentials(credentials));
  });

  it('preserves terminal authentication in the genuine protected managed acquire to Session-start child cipher', async () => {
    await withTempDir('happier-terminal-managed-child-', async taskDir => {
      const originalConfiguration = { happyHomeDir: configuration.happyHomeDir, settingsFile: configuration.settingsFile };
      Object.assign(configuration, { happyHomeDir: taskDir, settingsFile: join(taskDir, 'settings.json') });
      try {
        const seed = new Uint8Array(32).fill(19);
        const publicKey = ed25519.getPublicKey(seed);
        const material = { type: 'dataKey' as const,
          machineKey: deriveAccountMachineKeyFromRecoverySecret(new Uint8Array(32).fill(23)) };
        const controller = { kind: 'machine' as const, machineId: 'alice-controller' };
        const guest = { kind: 'machine' as const, machineId: 'alice-guest' };
        const guestSeed = new Uint8Array(32).fill(37);
        const guestPublicKey = ed25519.getPublicKey(guestSeed);
        const guestPrivateKey = new Uint8Array([...guestSeed, ...guestPublicKey]);
        const acquireEnvelope = { v: 1 as const, requestId: 'request-1', target: controller, input: {} };
        const authorization: ExternalActionExecutionAuthorizationV1 = { v: 1, token: 'terminal-acquire-root', binding: {
          accountId: 'bob', authentication: { kind: 'terminal', tokenEpoch: 7 }, accountEncryptionMode: 'e2ee',
          serverIdentityId: homeIdentityId, custodianAccountId: 'alice', machineId: controller.machineId,
          installationId: 'controller-installation', actionId: 'machines.managed.acquire', requestId: 'request-1',
          target: controller, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(acquireEnvelope),
        } };
        const binding = { serverIdentityId: homeIdentityId, accountId: 'bob', authentication: { kind: 'terminal' as const, tokenEpoch: 7 },
          actionId: 'session.spawn_new', requestId: 'request-1', target: guest };
        let opened: unknown;
        let signatureValid = false;
        const server = createServer(async (request, response) => {
          if (request.method === 'GET') {
            response.setHeader('Content-Type', 'application/json');
            response.end(JSON.stringify({ features: {}, capabilities: { serverIdentity: { serverIdentityId: homeIdentityId } } }));
            return;
          }
          let raw = '';
          for await (const chunk of request) raw += String(chunk);
          // Signed requests carry their proofs in the JSON frame; restore them as Home does.
          const frame = request.headers[EXTERNAL_ACTION_HTTP_BODY_HEADER_V1] === undefined ? null : decodeExternalActionHttpBodyV1(JSON.parse(raw));
          const body: unknown = frame ? frame.body : JSON.parse(raw);
          const proofHeaders: Readonly<Record<string, unknown>> = frame ? frame.headers : request.headers;
          if (request.url === '/v1/machines/managed/controller/context') {
            expect(body).toMatchObject({ homeId: homeIdentityId, managedId: 'managed-guest', expectedIntentRevision: 1,
              controller: { machineId: controller.machineId, installationId: 'controller-installation' }, includeEnrollmentInstallation: true });
            response.setHeader('Content-Type', 'application/json');
            response.end(JSON.stringify({ requestId: 'request-1', enrollmentInstallation: { machineId: guest.machineId,
              installationId: 'guest-installation', installationPublicKey: encodeBase64(guestPublicKey, 'base64url') } }));
            return;
          }
          const parsed = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
          if (parsed.envelope.v !== 2) throw new Error('Expected protected terminal child');
          const signature = proofHeaders[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER.toLowerCase()];
          signatureValid = typeof signature === 'string' && verifyExternalActionMachineRequestV1({
            authorizationToken: authorization.token, effectActionId: 'machines.managed.acquire', target: controller,
            installationId: 'controller-installation', requestId: 'request-1', method: 'POST',
            path: '/v1/actions/session.spawn_new', body, publicKey, signature });
          const childAuthorization: ExternalActionExecutionAuthorizationV1 = { v: 1, token: 'actual-home-child', binding: {
            ...authorization.binding, ...binding, machineId: guest.machineId, installationId: 'guest-installation', custodianAccountId: 'bob',
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(parsed.envelope), managedContinuation: {
              managedId: 'managed-guest', creationRequestId: 'request-1', expectedIntentRevision: 1,
              controller: { machineId: controller.machineId, installationId: 'controller-installation' },
              acquireRequestEnvelopeDigest: authorization.binding.requestEnvelopeDigest } } };
          const childMaterial = openManagedCreationActionCodecV1({ authorization: childAuthorization, envelope: parsed.envelope,
            machineId: guest.machineId, installationId: 'guest-installation', serverIdentityId: homeIdentityId, installationPrivateKey: guestPrivateKey });
          if (!childMaterial) throw new Error('Exact guest child codec did not open');
          expect(childMaterial.machineKey).not.toEqual(material.machineKey);
          opened = openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: parsed.envelope, binding, material: childMaterial })?.input;
          response.setHeader('Content-Type', 'application/json');
          response.end(JSON.stringify(prepareExternalActionResponseV2({ request: parsed.envelope, binding, material: childMaterial,
            executedMachineId: guest.machineId, randomBytes: length => new Uint8Array(length).fill(6),
            execution: { ok: false, errorCode: 'fixture_receipt', error: 'fixture_receipt' } }).response));
        });
        servers.push(server);
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('Home fixture did not listen');
        const serverUrl = `http://127.0.0.1:${address.port}`;
        await updateSettings(settings => ({ ...settings, servers: { ...settings.servers,
          terminalChildHome: { id: 'terminalChildHome', name: 'Terminal child Home', serverUrl, webappUrl: serverUrl,
            createdAt: 1, updatedAt: 1, lastUsedAt: 1, homeConnectionDescriptorAuthority: 'exact',
            homeConnectionDescriptor: { v: 1, homeServerIdentityId: homeIdentityId, canonicalServerUrl: serverUrl,
              revision: 1, endpoints: [{ kind: 'https', url: serverUrl }] } } } }));
        const input = SessionSpawnNewInputV2Schema.parse({ executionTarget: { serverId: 'terminalChildHome', machineId: guest.machineId },
          directory: { kind: 'managed' }, agentTarget: { kind: 'agent', identity: { pluginId: 'acme.agent', localId: 'coding' } } });
        const result = await dispatchManagedSessionStart({ input, authorization, installationId: 'controller-installation',
          privateKey: new Uint8Array([...seed, ...publicKey]), serverHttpBaseUrl: serverUrl, material,
          continuation: { managedId: 'managed-guest', creationRequestId: 'request-1', expectedIntentRevision: 1 } });
        expect(result).toMatchObject({ errorCode: 'fixture_receipt' });
        expect(signatureValid).toBe(true);
        expect(opened).toMatchObject({ executionTarget: { serverId: homeIdentityId, machineId: guest.machineId },
          agentTarget: input.agentTarget });
      } finally { Object.assign(configuration, originalConfiguration); }
    });
  });

  it('delivers encrypted terminal Session creation when its admitted wake controller is outside the target inventory', async () => {
    await withConfiguredDaemonTestHome({ prefix: 'happier-spawn-wake-controller-' }, async () => {
      const events: string[] = [];
      const inventoryResponses: Array<Readonly<{ path: string; rows: number }>> = [];
      const target = await home('e2ee', events, { finiteWake: true, originalOwnAction: 'session.spawn_new',
        authenticationKind: 'terminal', custodianAccountId: 'bob', controllerCustodianAccountId: 'bob', controllerInventoryAbsent: true,
        onInventoryResponse: (path, rows) => { inventoryResponses.push({ path, rows }); } });
      const input = SessionSpawnNewInputV2Schema.parse({ creationKey: 'read-only-isolation',
        executionTarget: { serverId: homeIdentityId, machineId: 'alice-machine' },
        directory: { kind: 'path', path: '/tmp' }, permissionMode: 'read-only',
        agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } });
      const executor = createCliActionExecutorFromCredentials({ credentials: {
        token: token('terminal'), credentialProvenance: 'stored_session',
        encryption: { type: 'legacy', secret: new Uint8Array(32).fill(23) },
      }, externalActionClient: true, serverId: 'home', serverIdentityId: homeIdentityId, serverApiUrl: target.url,
        actionsSettingsProvider: { getActionsSettings: () => normalizeActionsSettingsV1({ v: 1 }) } });
      expect(await executor.execute('session.spawn_new', input, { surface: 'cli', authority: 'account_automation', actionRequestId: 'request-1' }))
        .toMatchObject({ ok: false, errorCode: 'fixture_receipt' });
      expect(events).toEqual(['home-authorized', 'dispatch']);
      expect(inventoryResponses).toEqual([{ path: '/v1/machines/alice-machine', rows: 1 }]);
      const delivered = ExternalActionExecutionAuthorizationRequestV1Schema.parse(target.readReceived());
      expect(delivered.executionAuthorization?.binding).toMatchObject({ actionId: 'session.spawn_new',
        accountId: 'bob', custodianAccountId: 'bob', authentication: { kind: 'terminal', tokenEpoch: 7 } });
      expect(delivered.executionAuthorization?.managedFiniteWake?.target.controller)
        .toEqual({ machineId: 'alice-controller', installationId: 'controller-installation' });
    });
  });

  it('refuses a controller-free target in the native finite-wake custody carrier', async () => {
    const events: string[] = [];
    const target = await home('plain', events, { finiteWake: true, accountOwnedFiniteWake: true, custodianAccountId: 'bob' });
    const result = await dispatchOriginalAccountAction({ actionId: 'projects.script.run',
      input: PROJECT_ACTION_INPUT_SCHEMAS_V1['projects.script.run'].parse({
        workspace: { serverId: 'home', workspaceId: 'workspace-1', machineId: 'alice-machine', rootPath: '/workspace' },
        selection: { kind: 'named', name: 'test' } }),
      requestId: 'request-1', target: { kind: 'machine', machineId: 'alice-machine' },
      credentials: { token: token(), encryption: null }, serverHttpBaseUrl: target.url, serverIdentityId: homeIdentityId });
    expect(result).toMatchObject({ ok: false, errorCode: 'admission_unavailable' });
    expect(target.readReceived()).toBeUndefined();
  });

  it.each(['bob', 'alice'] as const)('captures the same original finite root for a %s-owned guest and genuine Bob custody on its foreign controller', async guestCustodian => {
    const events: string[] = [];
    const inventoryResponses: Array<Readonly<{ path: string; rows: number }>> = [];
    const target = await home('plain', events, { finiteWake: true, custodianAccountId: guestCustodian,
      onInventoryResponse: (path, rows) => { inventoryResponses.push({ path, rows }); } });
    const credentials: StoredCredentials = { token: token(), encryption: null };
    const disclosedRecipients: string[] = [];
    const result = await dispatchOriginalAccountAction({ actionId: 'projects.script.run',
      input: PROJECT_ACTION_INPUT_SCHEMAS_V1['projects.script.run'].parse({
        workspace: { serverId: 'home', workspaceId: 'workspace-1', machineId: 'alice-machine', rootPath: '/workspace' },
        selection: { kind: 'named', name: 'test' } }),
      requestId: 'request-1', target: { kind: 'machine', machineId: 'alice-machine' }, credentials,
      serverHttpBaseUrl: target.url, serverIdentityId: homeIdentityId,
      onRequesterSessionCredentialDisclosure: async disclosure => {
        expect(disclosure.accountId).toBe('bob');
        expect(disclosure.fullSignIn).toBe(true);
        if (disclosure.machineId === 'alice-controller') expect(disclosure).toMatchObject({
          custodian: { accountId: 'alice', displayName: 'Alice' },
        });
        expect(target.readReceived()).toBeUndefined();
        disclosedRecipients.push(disclosure.machineId);
        return true;
      } });
    expect(result).toMatchObject({ errorCode: 'fixture_receipt' });
    expect(inventoryResponses).toEqual([{ path: '/v1/machines/alice-machine', rows: 1 }]);
    expect(disclosedRecipients).toEqual(guestCustodian === 'bob'
      ? ['alice-controller'] : ['alice-machine']);
    const received = ExternalActionExecutionAuthorizationRequestV1Schema.parse(target.readReceived());
    const authorization = received.executionAuthorization;
    expect(authorization?.binding).toMatchObject({ accountId: 'bob', custodianAccountId: guestCustodian,
      machineId: 'alice-machine', installationId: 'alice-installation', actionId: 'projects.script.run', requestId: 'request-1' });
    expect(authorization?.binding.requestEnvelopeDigest).toBe(computeExternalActionRequestEnvelopeDigestV1(received.envelope));
    expect(authorization?.managedFiniteWake?.requesterAccountContext?.installationId).toBe('controller-installation');
    if (!authorization?.managedFiniteWake) throw new Error('Expected the exact Home finite-wake hint');
    expect(openExternalActionRequesterAccountContextV1({ authorization,
      purpose: { kind: 'managed_finite_wake', target: authorization.managedFiniteWake.target },
      machineId: 'alice-controller', installationId: 'controller-installation', serverIdentityId: homeIdentityId,
      installationPrivateKey: target.controllerPrivateKey })).toEqual(encodeStoredCredentials(credentials));
    expect(authorization.requesterAccountContext === undefined).toBe(guestCustodian === 'bob');
    if (guestCustodian === 'alice') expect(openExternalActionRequesterAccountContextV1({ authorization,
      purpose: { kind: 'external_action' }, machineId: 'alice-machine', installationId: 'alice-installation',
      serverIdentityId: homeIdentityId, installationPrivateKey: target.privateKey })).toEqual(encodeStoredCredentials(credentials));
    expect(events).toContain('home-authorized');
    expect(JSON.stringify(received)).not.toContain(credentials.token);
  });

  it('retains own finite work without any managed hint, disclosure or private Box', async () => {
    const events: string[] = [];
    const target = await home('plain', events, { finiteAction: true, custodianAccountId: 'bob' });
    const result = await dispatchOriginalAccountAction({ actionId: 'projects.script.run',
      input: PROJECT_ACTION_INPUT_SCHEMAS_V1['projects.script.run'].parse({
        workspace: { serverId: 'home', workspaceId: 'workspace-1', machineId: 'alice-machine', rootPath: '/workspace' },
        selection: { kind: 'named', name: 'test' } }),
      requestId: 'request-1', target: { kind: 'machine', machineId: 'alice-machine' },
      credentials: { token: token(), encryption: null }, serverHttpBaseUrl: target.url, serverIdentityId: homeIdentityId,
      onRequesterSessionCredentialDisclosure: async () => { throw new Error('There is no foreign recipient'); } });
    expect(result).toMatchObject({ errorCode: 'fixture_receipt' });
    const received = ExternalActionExecutionAuthorizationRequestV1Schema.parse(target.readReceived());
    expect(received.executionAuthorization?.binding).toMatchObject({ accountId: 'bob', custodianAccountId: 'bob' });
    expect(received.executionAuthorization?.managedFiniteWake).toBeUndefined();
    expect(received.executionAuthorization?.requesterAccountContext).toBeUndefined();
  });

  it('refuses legacy credentials that cannot establish required Machine admission', async () => {
    const events: string[] = [];
    const target = await home('plain', events, { custodianAccountId: 'bob' });
    const legacyToken = `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: 'bob' })).toString('base64url')}.signature`;
    const result = await dispatchOriginalAccountAction({ actionId: 'agents.models.list', input: {}, requestId: 'request-1',
      target: { kind: 'machine', machineId: 'alice-machine' }, credentials: { token: legacyToken, encryption: null },
      serverHttpBaseUrl: target.url, foreignTargetOnly: true });
    expect(result).toMatchObject({ ok: false, errorCode: 'admission_unavailable' });
    expect(target.readReceived()).toBeUndefined();
  });

  it('withholds accepted private custody when credentials retire during confidentiality consent', async () => {
    const events: string[] = [];
    const target = await home('plain', events);
    let current = true;
    const result = await dispatchOriginalAccountAction({ actionId: 'agents.models.list', input: {}, requestId: 'request-1',
      target: { kind: 'machine', machineId: 'alice-machine' }, credentials: { token: token(), encryption: null },
      serverHttpBaseUrl: target.url, serverIdentityId: homeIdentityId, isCurrent: () => current,
      onRequesterSessionCredentialDisclosure: async () => { current = false; return true; } });
    expect(result).toMatchObject({ ok: false, errorCode: 'target_unavailable' });
    expect(target.readReceived()).toBeUndefined();
  });

  it.each(['plain', 'e2ee'] as const)('delivers a fresh cross-Account Stop from JSON CLI without disclosing a sign-in (%s)', async mode => {
    const events: string[] = [];
    const requestPaths: Array<string | undefined> = [];
    const actionId = 'localServices.actions.stopManaged' as const;
    const currentness = await createRequesterCurrentnessSocketHarness();
    const artifacts = fastify();
    registerAccountArtifactRoutes(artifacts, 'bob', { encryptionMode: mode });
    await artifacts.ready();
    const stopped = LocalServiceActionResultV1Schema.parse({ v: 1, requestId: 'stop-request',
      action: 'stop_managed', status: 'succeeded', auditEvents: [] });
    const target = await home(mode, events, { originalOwnAction: actionId, artifacts, onRequestPath: path => requestPaths.push(path),
      ownExecution: { ok: true, result: stopped } });
    const reviewed = LocalServiceActionRequestV1Schema.parse({ requestId: 'stop-request', action: 'stop_managed', target: {
      kind: 'managed_service', managedServiceId: 'moved-instance', machineId: 'alice-machine',
      workspaceId: 'worker-ref', cwd: '/worker/project', declaration: {
        workspaceRefId: 'worker-ref', selection: { kind: 'manifest', name: 'web' },
      },
    }, force: false, confirmationNonce: 'stop-confirmation' });
    const input = { ...reviewed, confirmationNonce: createLocalServiceActionConfirmationNonceV1(reviewed) };
    const credentials: StoredCredentials = { token: token(), encryption: mode === 'plain' ? null
      : { type: 'legacy', secret: new Uint8Array(32).fill(23) }, credentialProvenance: 'stored_session' };
    terminal.interactive = false;
    const output = captureConsoleText();
    try {
      await handleActionsCommand(['invoke', actionId, '--machine-id', 'alice-machine', '--request-id', 'request-1',
        '--input-json', JSON.stringify(input), '--yes', '--json'], {
        readCredentialsFn: async () => credentials,
        createExecutorFn: params => createCliActionExecutorFromCredentials({ ...params,
          serverId: 'home', serverApiUrl: target.url, serverIdentityId: homeIdentityId,
          actionsSettingsProvider: { getActionsSettings: () => normalizeActionsSettingsV1({ v: 1,
            actions: { [actionId]: { approvalRequiredSurfaces: ['cli'] } } }),
            getAccountSettings: () => ({ actionsSettingsV1: { v: 1,
              actions: { [actionId]: { approvalRequiredSurfaces: ['cli'] } } } }) } }),
      });
      const [approval, emitted] = output.lines.map(line => JSON.parse(line) as unknown);
      expect(output.lines).toHaveLength(2);
      expect(approval).toMatchObject({ ok: true, data: { kind: 'approval_request_created', actionId } });
      expect(emitted, JSON.stringify(emitted)).toMatchObject({ ok: true, data: stopped });
      const received = ExternalActionExecutionAuthorizationRequestV1Schema.parse(target.readReceived());
      expect(received.executionAuthorization?.binding).toMatchObject({ actionId, accountId: 'bob',
        custodianAccountId: 'alice', machineId: 'alice-machine' });
      const opening = { authorization: received.executionAuthorization, machineId: 'alice-machine',
        installationId: 'alice-installation', serverIdentityId: homeIdentityId, installationPrivateKey: target.privateKey };
      const codec = openManagedControllerActionCodecV1(opening);
      expect(codec).not.toBeNull();
      expect(openExternalActionRequesterAccountContextV1({ ...opening, purpose: { kind: 'external_action' } })).toBeNull();
      if (received.envelope.v === 2 && codec) expect(openExternalActionRequestV2({
        projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: received.envelope,
        binding: received.executionAuthorization!.binding, material: codec,
      })?.input).toEqual(input);
      else expect(received.envelope).toMatchObject({ v: 1, input });
      expect(terminal.prompts).toEqual([]);
      expect(events, JSON.stringify(requestPaths)).toEqual(['home-authorized', 'dispatch']);
      expect(JSON.stringify(received)).not.toContain(credentials.token);
    } finally { output.restore(); await currentness.close(); await artifacts.close(); }
  });

  it.each(['yes', 'no', 'noninteractive', 'json'] as const)('requires actual CLI confidentiality consent before private delivery (%s)', async answer => {
    const events: string[] = [];
    const target = await home('plain', events);
    terminal.interactive = answer !== 'noninteractive'; terminal.answer = answer === 'yes' ? 'yes' : 'no';
    const credentials: StoredCredentials = { token: token(), encryption: null, credentialProvenance: 'stored_session' };
    const output = captureConsoleText();
    try {
      await handleActionsCommand(['invoke', 'agents.models.list', '--machine-id', 'alice-machine', '--request-id', 'request-1',
        '--input-json', JSON.stringify(ownMachineInput), ...(answer === 'json' ? ['--json'] : [])], {
        readCredentialsFn: async () => credentials,
        createExecutorFn: params => createCliActionExecutorFromCredentials({ ...params,
          serverId: 'home', serverApiUrl: target.url, serverIdentityId: homeIdentityId,
          actionsSettingsProvider: { getActionsSettings: () => normalizeActionsSettingsV1({ v: 1 }) } }),
      });
      if (answer === 'yes') {
        expect(target.readReceived()).toBeDefined();
        expect(terminal.prompts[0]).toContain('[y/N]');
        expect(terminal.prompts[0]).toMatch(/account/i);
        expect(terminal.prompts[0]).toMatch(/files|output|sign-ins/i);
      } else expect(target.readReceived()).toBeUndefined();
      if (answer === 'json' || answer === 'noninteractive') expect(terminal.prompts).toEqual([]);
    } finally { output.restore(); }
  });

  it.each(['missing-disclosure', 'informational-only', 'rejected-disclosure', 'changed-root', 'terminal-human-upgrade'] as const)('withholds private custody for %s', async reason => {
    const events: string[] = [];
    const target = await home('plain', events, { mutateRoot: reason === 'changed-root' });
    const disclosure = reason === 'missing-disclosure' ? {} : { onRequesterSessionCredentialDisclosure: async () => {
      events.push('disclosed');
      if (reason === 'informational-only') return;
      return reason !== 'rejected-disclosure';
    } };
    const result = await dispatchOriginalAccountAction({ actionId: 'agents.models.list', input: ownMachineInput,
      requestId: 'request-1', target: { kind: 'machine', machineId: 'alice-machine' }, credentials: { token: token(reason === 'terminal-human-upgrade' ? 'terminal' : 'account'), encryption: null },
      serverHttpBaseUrl: target.url, serverIdentityId: homeIdentityId, ...disclosure });
    expect(result.ok).toBe(false);
    expect(target.readReceived()).toBeUndefined();
  });
});
