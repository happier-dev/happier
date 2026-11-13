import { createNativeSoftwareInstallFixture, osStore, type NativeSoftwareScenario } from '@/testkit/machines/nativeSoftwareInstall';
import { nativeTerminal } from '@/testkit/machines/nativeSoftwareOs';
import axios, { AxiosHeaders } from 'axios';
import { randomBytes } from 'node:crypto';
import { sealAccountSettingsV2RawContent } from '@/settings/accountSettings/updateAccountSettingsV2WithRetry';
import { expect, onTestFailed, onTestFinished, vi } from 'vitest';
import { SOCKET_RPC_EVENTS, type SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';
import { ExternalActionResponseEnvelopeV1Schema, ExternalActionRequestEnvelopeSchema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1, signExternalActionApprovalInputV1, verifyExternalActionMachineRequestV1, decodeExternalActionResolvedTargetV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { configuration } from '@/configuration';
import { readFile, writeFile } from 'node:fs/promises';
import { MachineSetupPlanResultV1Schema, ManagedMachineActionOutputSchemasV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { resolveInstalledMachineEffectCli } from '@/machines/adminAccess/runElevatedEffect';
import { ExternalActionExecutionAuthorizationRequestV1Schema, ExternalActionExecutionAuthorizationVerifyRequestV1Schema, ExternalActionExecutionAuthorizationV1Schema, bindExternalActionExecutionAuthorizationHttpPathV1, bindExternalActionExecutionAuthorizationVerifyHttpPathV1, EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER, EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER, EXTERNAL_ACTION_RESOLVED_TARGET_HEADER, projectExternalActionApprovalDecisionEnvelopeAdmissionV1, projectExternalActionDeploymentPreparationEnvelopeAdmissionV1, type ExternalActionExecutionAuthorizationV1 } from '@happier-dev/protocol/actions/externalActionApi';
import type { RpcActionExecutorContext } from '@/rpc/handlers/_actionDispatchAdapter';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { ActionOperationGetV1ResponseSchema, ACTION_OPERATION_RPC_METHODS_V2 } from '@happier-dev/protocol/actions/operations/v1';
import { callExactMachineRpc } from '@/session/transport/rpc/machineRpc';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { getLiveSystemTasksRunnerAdapter } from '@/capabilities/systemTasks/liveSystemTasksRunner';
import { MachineSetupApplyInputV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { createCanonicalJsonSigningInput } from '@happier-dev/protocol/crypto/canonicalJson';
import { WORKFLOW_RUN_STORAGE_HTTP_PATH } from '@/daemon/workflows/workflowRunStorageClient';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { FeaturesResponseSchema } from '@happier-dev/protocol';
import { computeActionInputApprovalDigestV1 } from '@happier-dev/protocol/actions/decisionAuthority';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { ExternalActionRequesterInvocationV1Schema, openExternalActionRequesterAccountContextV1, openManagedControllerActionCodecV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { readCarrierMutation } from '@/api/artifacts/accountArtifactStore.testkit';
import { artifactListResponse, artifactReadResponse } from '@/testkit/http/artifactHome';
import { createCliApprovalsArtifactStore } from '@/session/actions/approvals/artifactStore';
import { ARTIFACT_UPLOAD_PATH_V1 } from '@happier-dev/transfers';
import { ACCOUNT_API_TOKENS_LIST_HTTP_PATH_V1 } from '@happier-dev/protocol/auth/accountApiTokens';
import { MachineInstallationProofPayloadV1Schema, MachineInstallationProofV1Schema, verifyMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { SocketRpcMachineAdmissionContextV1Schema } from '@happier-dev/protocol/machines/machineAccessV1';
import { SIGNED_ROOT_ACTION_EXECUTE_PATH } from '@/daemon/externalActions/signedRootActionControl';
import { readBundledPluginAvailabilityHttpFixture } from '@/plugins/testkit/bundledPluginAvailabilityHttpFixture';
import { logger } from '@/ui/logger';

function decodeNativeConfirmation(context: RpcActionExecutorContext) {
  return ExternalActionRequesterInvocationV1Schema.parse(JSON.parse(JSON.stringify({
    caller: context.actionCaller, surface: context.surface, authority: context.authority,
    presentUserConfirmation: context.presentUserConfirmation,
  }))).presentUserConfirmation;
}

function requireEnvelopeRequestId(requestId: string | undefined): string {
  if (!requestId) throw new Error('Native Home workflow proposals carry their request id');
  return requestId;
}

export function withNativeConfirmation(actionId: 'machines.setup.plan' | 'machines.setup.apply' | 'machines.setup.remove', input: unknown,
  context: RpcActionExecutorContext): RpcActionExecutorContext {
  const binding = context.externalActionExecutionAuthorization?.binding;
  const accountId = binding?.accountId ?? context.runtimeAccountId;
  const serverId = binding?.serverIdentityId ?? context.serverIdentityId;
  if (!accountId || !serverId || !context.actionRequestId) throw new Error('Native review needs the exact Account invocation');
  return { ...context, surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
    runtimeAccountId: accountId, serverIdentityId: serverId,
    presentUserConfirmation: { actionId, inputDigest: computeActionInputApprovalDigestV1(actionId, getActionSpec(actionId).inputSchema.parse(input)),
      requestId: context.actionRequestId, accountId, serverId,
      target: context.externalActionTarget ?? null } };
}
export async function exercisePublicPackagePlanApply(scenario: NativeSoftwareScenario, askAndDecideValue = false,
  exerciseInstalled?: (fixture: Awaited<ReturnType<typeof createNativeSoftwareInstallFixture>>,
    admitRoot: (authorization: ExternalActionExecutionAuthorizationV1) => void,
    accountChannel: Awaited<ReturnType<typeof createRequesterCurrentnessSocketHarness>>) => Promise<void>,
  runtimeOptions?: Parameters<typeof createNativeSoftwareInstallFixture>[0]['runtimeOptions'],
  sessionStartup?: Parameters<typeof createNativeSoftwareInstallFixture>[0]['sessionStartup'],
  accountEncryptionMode?: 'plain' | 'e2ee', accountRecoverySecret?: Uint8Array) {
  const askAndDecide = askAndDecideValue === true;
  const nativeConfirmed = scenario === 'native-confirm';
  let phase = 'create_native_fixture';
  if (nativeConfirmed) onTestFailed(() => { console.error(`Confirmed native install phase: ${phase}`); });
  if (nativeConfirmed) onTestFailed(async () => {
    logger.flushSync();
    const log = await readFile(logger.getLogPath(), 'utf8').catch(() => '');
    const refusals = log.split('\n').flatMap<Readonly<{ phase: string; refusalBranch?: string }>
      | Readonly<{ method: string; outcomeCode: string; admissionPredicate?: string }>>(line => {
      const marker = ['[RPC] Request completed', '[external-action-phase]'].find(value => line.includes(value));
      if (!marker) return [];
      const offset = line.indexOf(marker);
      const start = line.indexOf('{', offset + marker.length);
      if (start === -1) return [];
      let row: unknown;
      try { row = JSON.parse(line.slice(start)); } catch { return []; }
      if (!row || typeof row !== 'object') return [];
      if (marker === '[external-action-phase]') {
        const phase = 'phase' in row ? row.phase : undefined;
        const refusalBranch = 'refusalBranch' in row ? row.refusalBranch : undefined;
        return typeof phase === 'string' ? [{ phase,
          ...(typeof refusalBranch === 'string' ? { refusalBranch } : {}) }] : [];
      }
      const method = 'method' in row ? row.method : undefined;
      const outcomeCode = 'outcomeCode' in row ? row.outcomeCode : undefined;
      if (typeof method !== 'string' || typeof outcomeCode !== 'string' || outcomeCode === 'ok') return [];
      const admissionPredicate = 'admissionPredicate' in row ? row.admissionPredicate : undefined;
      return [{ method, outcomeCode, ...(typeof admissionPredicate === 'string' ? { admissionPredicate } : {}) }];
    });
    console.error('Native receiving refusals:', refusals);
  });
  const manager = scenario === 'brew' ? 'brew' : 'apt';
  const removing = scenario.startsWith('remove-');
  const firstPresence = scenario.startsWith('first-') || removing;
  let initiallyPresent = scenario === 'first-present' || scenario === 'first-forged-absent';
  const excludedToSelected = scenario === 'excluded-to-selected';
  const fixture = await createNativeSoftwareInstallFixture({ scenario,
    ...(accountEncryptionMode ? { accountEncryptionMode } : {}),
    ...(accountRecoverySecret ? { accountRecoverySecret } : {}),
    ...(runtimeOptions ? { runtimeOptions } : {}),
    ...(sessionStartup ? { sessionStartup } : {}),
    ...(nativeConfirmed ? { serverId: 'native-software-fixture', serverHttpBaseUrl: 'https://native-software.invalid' } : {}) });
  phase = 'prepare_native_home_transport';
  if (nativeConfirmed) onTestFailed(() => { console.error('Native command settlement:', fixture.nativeCommands); });
  if (nativeConfirmed) onTestFailed(() => {
    fixture.captureNativeDiagnostics();
    console.error('Native Workflow settlement:', JSON.stringify(fixture.workflowDiagnostic()));
  });
  const { machine, client, installation, sources, context, statePath, metadataWrites, rootLaunches, rootPlans } = fixture;
  const expectNativeMetadataPublications = () => {
    // Real discovery publishes Agent inventory before the one Setup write.
    // Keep every CAS: a duplicate Setup publication or any unrelated write
    // must fail this exact sequence, including after receipt rejoin.
    expect(fixture.workflowDiagnostic().metadataPublications.map(({ version, changedKeys }) => ({ version, changedKeys })))
      .toEqual([{ version: 1, changedKeys: ['agentInventory'] }, { version: 2, changedKeys: ['setup'] }]);
    expect(metadataWrites).toHaveLength(2);
    expect(machine.metadataVersion).toBe(2);
  };
  const approvalArtifacts: unknown[] = [];
  const workflowRequesterCustody: Array<{ codecOpened: boolean; requesterCredentialsAbsent: boolean; parentAuthentication: boolean }> = [];
  if (nativeConfirmed) onTestFailed(() => { console.error('Native Workflow requester custody:', workflowRequesterCustody); });
  const artifacts = new Map<string, Readonly<Record<string, unknown>> & Readonly<{ id: string }>>();
  let explicitAsk = askAndDecide;
  let operationIndex = 0;
  const operations = nativeConfirmed ? fixture.operations : createHostActionOperationRuntime({ machineId: machine.id,
    custodyBinding: { serverId: configuration.activeServerId, installationId: installation.installationId },
    resolveAccountId: async () => 'alice', generateOperationId: () => operationIndex++ === 0 ? 'public-package-operation' : `public-package-${operationIndex}` });
  const nativeDeps = { ...createUnavailableActionTransportDeps(),
    machineSetupPlan: fixture.machineSetupPlan,
    machineSetupApply: fixture.machineSetupApply,
    machineSetupRemove: fixture.machineSetupRemove,
    runActionOperation: operations.runActionOperation,
  };
  const readActionsSettings = () => ActionsSettingsV1Schema.parse({ v: 1, ...(explicitAsk ? {
    actions: { 'machines.setup.apply': { approvalRequiredSurfaces: ['ui'] } },
  } : {}) });
  if (nativeConfirmed) {
    phase = 'start_native_account_channel';
    const accountChannel = await createRequesterCurrentnessSocketHarness();
    phase = 'prepare_native_home_transport';
    onTestFinished(() => accountChannel.close());
    const materializationRpcDeliveries: Array<{ method: string;
      phase: 'received' | 'manager_pending' | 'manager_settled' | 'ack_sent' | 'rejected'; errorCode?: string }> = [];
    accountChannel.server.on('connection', peer => {
      // The same Account has independent UI and installed-daemon sockets.
      // Authenticate only those exact fixture-issued credentials, without
      // including either bearer in an assertion's diagnostic output.
      expect(peer.handshake.auth.token === fixture.issuerCredentials.token
        || peer.handshake.auth.token === fixture.credentials.token).toBe(true);
      peer.on(SOCKET_RPC_EVENTS.CALL, (packet: SocketRpcRequestPayload, acknowledge: (response: unknown) => void) => {
        const method = packet.method;
        const known = [RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE,
          RPC_METHODS.CAPABILITIES_DETECT, RPC_METHODS.DAEMON_PLUGIN_ACTION_SCHEMAS_READ]
          .find(value => method === `${machine.id}:${value}`);
        const delivery: (typeof materializationRpcDeliveries)[number] = { method: known ?? 'other', phase: 'received' };
        materializationRpcDeliveries.push(delivery);
        delivery.phase = 'manager_pending';
        void fixture.receiveRpc(packet, {
          actorAccountId: 'alice',
          custodianAccountId: 'alice',
          machineId: machine.id,
          installationId: installation.installationId,
          role: 'manage',
          encryptionMode: fixture.accountEncryptionMode,
        }).then(response => {
          delivery.phase = 'manager_settled';
          const result = response.result;
          const code = result && typeof result === 'object' && 'errorCode' in result ? result.errorCode : undefined;
          if (typeof code === 'string' && /^[a-zA-Z0-9_.:-]+$/u.test(code)) delivery.errorCode = code;
          acknowledge(response);
          delivery.phase = 'ack_sent';
        }, (error: unknown) => {
          delivery.phase = 'rejected';
          const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
          if (typeof code === 'string' && /^[a-zA-Z0-9_.:-]+$/u.test(code)) delivery.errorCode = code;
          acknowledge({ ok: false, errorCode: 'fixture_rpc_delivery_failed', error: 'Native Home RPC delivery failed' });
        });
      });
    });
    onTestFailed(() => { console.error('Native Home materialization RPC settlement:', materializationRpcDeliveries); });
    const homeActionDeliveries: Array<{ actionId: string; origin: 'workflow' | 'ordinary';
      phase: 'delivering' | 'settled' | 'rejected'; executionOk?: boolean; errorCode?: string }> = [];
    onTestFailed(() => { console.error('Native Home Action settlement:', homeActionDeliveries); });
    const roots = new Map<string, ExternalActionExecutionAuthorizationV1>();
    let workflowParent: ExternalActionExecutionAuthorizationV1 | undefined;
    fixture.setHomeRead(url => {
      const path = new URL(url).pathname;
      if (/\/v[12]\/account\/settings$/u.test(path)) return { status: 200,
        data: { content: sealAccountSettingsV2RawContent({ credentials: fixture.credentials,
          raw: { actionsSettingsV1: readActionsSettings() }, envelopeKind: fixture.accountEncryptionMode === 'plain' ? 'plain' : 'encrypted',
          randomBytes }), version: 1 } };
      if (path === '/v2/changes') return { status: 200, data: { changes: [], nextCursor: 0 } };
      if (path === ACCOUNT_API_TOKENS_LIST_HTTP_PATH_V1) return { status: 200, data: { tokens: [] } };
      if (path === '/v1/account/saved-secrets/resources/materials') return { status: 200, data: { resources: [] } };
      if (path === '/v1/artifacts') return { status: 200, data: artifactListResponse(url, [...artifacts.values()]) };
      const artifact = /^\/v1\/artifacts\/([^/]+)$/u.exec(path);
      if (artifact) {
        const row = artifacts.get(decodeURIComponent(artifact[1]!));
        return row ? { status: 200, data: row } : { status: 404, data: { error: 'Artifact not found' } };
      }
      return undefined;
    });
    // Only Home HTTP/storage and the updates endpoint are replaced. Workflow delivery keeps
    // its real sealed requester, child origin and receiver admission path.
    const features = FeaturesResponseSchema.parse({ features: { automations: { enabled: true }, workflows: { enabled: true } },
      capabilities: { serverIdentity: { serverIdentityId: 'srv_home' } } });
    const originalFetch = globalThis.fetch;
    const homeFetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (request, init) => {
      const url = new URL(request instanceof Request ? request.url : String(request));
      if (url.origin === fixture.controlHttpOrigin()) {
        const phase = url.pathname === SIGNED_ROOT_ACTION_EXECUTE_PATH ? 'control.root' : 'control.other';
        fixture.recordNativePhase(`${phase}.begin`);
        try {
          const response = await originalFetch(request, init);
          // This marks response headers only. The real control caller still
          // owns reading the unchanged Response body and closing its client.
          fixture.recordNativePhase(`${phase}.response`, response.status);
          return response;
        } catch (error) {
          fixture.recordNativePhase(`${phase}.rejected`);
          throw error;
        }
      }
      const path = url.pathname;
      const phase = path === '/v1/features' || path === '/v1/features/authenticated' ? 'home_fetch.features'
        : path === '/v1/account/encryption/currentness' ? 'home_fetch.currentness' : 'home_fetch.other';
      fixture.recordNativePhase(`${phase}.begin`);
      if (path === '/v1/features' || path === '/v1/features/authenticated') {
        const response = Response.json(features);
        fixture.recordNativePhase(`${phase}.response`, response.status);
        return response;
      }
      if (path === '/v1/account/encryption/currentness') {
        const response = Response.json(fixture.accountEncryptionCurrentness);
        fixture.recordNativePhase(`${phase}.response`, response.status);
        return response;
      }
      fixture.recordNativePhase(`${phase}.rejected`);
      throw new Error(`Unexpected native Home HTTP read: ${path}`);
    });
    const homeHttp = vi.spyOn(axios, 'post').mockImplementation(async (url, body, options) => {
      const path = new URL(String(url)).pathname;
      // Signed Home headers below accept strings, never method-default maps or arrays.
      const headers = new AxiosHeaders();
      for (const [name, value] of Object.entries(options?.headers ?? {})) {
        if (typeof value === 'string') headers.set(name, value);
      }
      let delivery: (typeof homeActionDeliveries)[number] | undefined;
      try {
      const pluginAvailability = readBundledPluginAvailabilityHttpFixture(path, body);
      if (pluginAvailability) return { status: 200, data: pluginAvailability };
      if (path === ACCOUNT_API_TOKENS_LIST_HTTP_PATH_V1) return { status: 200, data: { tokens: [] } };
      if (path === `/v1/machines/${machine.id}/admission/verify`) {
        if (!body || typeof body !== 'object' || !('v' in body) || body.v !== 1
          || !('context' in body) || !('proof' in body) || !('method' in body))
          throw new Error('Machine admission verification requires its canonical signed request');
        const { v: _version, proof: proofInput, ...rpcAdmission } = body;
        const admission = SocketRpcMachineAdmissionContextV1Schema.parse(rpcAdmission.context);
        const proof = MachineInstallationProofV1Schema.parse(proofInput);
        const ok = admission.actorAccountId === 'alice' && admission.custodianAccountId === 'alice'
          && verifyMachineInstallationProof({ publicKey: fixture.pair.publicKey, proof, payload: MachineInstallationProofPayloadV1Schema.parse({
            version: 1, accountId: 'alice', machineId: machine.id, installationId: installation.installationId,
            rpcAdmission,
          }) });
        return { status: ok ? 200 : 403, data: ok ? { v: 1, ok: true } : { error: 'access_denied' } };
      }
      if (path === WORKFLOW_RUN_STORAGE_HTTP_PATH)
        return { status: 200, data: await fixture.respondWorkflowStorage(body) };
      if (path === '/v1/artifacts/read') return artifactReadResponse(body, id => artifacts.get(id) ?? null);
      if (path === '/v1/artifacts' || path === ARTIFACT_UPLOAD_PATH_V1) {
        const input = readCarrierMutation(body);
        if (typeof input.id !== 'string') throw new Error('Artifact creation requires its canonical id');
        if (!askAndDecide) throw new Error('A confirmed install must not reach Artifact persistence');
        approvalArtifacts.push(input);
        artifacts.set(input.id, { ...input, id: input.id, ownerAccountId: 'alice', access: 'owner', encryptionMode: fixture.accountEncryptionMode,
          headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 });
        return { status: 200, data: { id: input.id, headerVersion: 1, bodyVersion: 1 } };
      }
      const artifact = /^\/v1\/artifacts\/([^/]+)$/u.exec(path);
      if (artifact) {
        const id = decodeURIComponent(artifact[1]!);
        const previous = artifacts.get(id);
        if (!previous) return { status: 404, data: { error: 'Artifact not found' } };
        const input = readCarrierMutation(body);
        if (input.expectedHeaderVersion !== previous.headerVersion || input.expectedBodyVersion !== previous.bodyVersion)
          return { status: 409, data: { success: false, error: 'version-mismatch' } };
        const headerVersion = Number(previous.headerVersion) + 1;
        const bodyVersion = Number(previous.bodyVersion) + 1;
        artifacts.set(id, { ...previous, ...input, id, headerVersion, bodyVersion });
        return { status: 200, data: { success: true, headerVersion, bodyVersion } };
      }
      const actionIds = ['machines.setup.plan', 'machines.setup.apply', 'approval.request.decide', 'template.instantiate',
        'workflow.run.invocations.get', 'workflow.run.invocations.retry'] as const;
      const verifyId = actionIds.find(id => path === bindExternalActionExecutionAuthorizationVerifyHttpPathV1(id));
      if (verifyId) {
        const verification = ExternalActionExecutionAuthorizationVerifyRequestV1Schema.parse(body);
        const token = headers.get(EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER);
        const root = typeof token === 'string' ? roots.get(token) : undefined;
        const signature = headers.get(EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER);
        const target = headers.get(EXTERNAL_ACTION_RESOLVED_TARGET_HEADER);
        const resolvedTarget = typeof target === 'string' ? decodeExternalActionResolvedTargetV1(target) : null;
        if (!root || !resolvedTarget || typeof signature !== 'string' || root.binding.actionId !== verifyId
          || !verifyExternalActionMachineRequestV1({ authorizationToken: root.token, effectActionId: verifyId,
            target: resolvedTarget, installationId: installation.installationId, requestId: root.binding.requestId,
            method: 'POST', path, body, publicKey: fixture.pair.publicKey, signature }))
          return { status: 403, data: { error: 'action_forbidden' } };
        return { status: 200, data: { ok: true } };
      }
      const actionId = actionIds.find(id => path === bindExternalActionExecutionAuthorizationHttpPathV1(id)
        || path === `/v1/actions/${id}`);
      if (!actionId) throw new Error(`Unexpected native Home HTTP path: ${path}`);
      const proposal = ExternalActionExecutionAuthorizationRequestV1Schema.safeParse(body);
      const envelope = ExternalActionRequestEnvelopeSchema.parse(proposal.success ? proposal.data.envelope : body);
      if (envelope.target?.kind !== 'machine')
        throw new Error('Native Home must deliver an exact Machine request');
      const bearer = headers.get('Authorization');
      expect(bearer === `Bearer ${fixture.credentials.token}` || bearer === `Bearer ${fixture.issuerCredentials.token}`)
        .toBe(true);
      const authentication = { kind: bearer === `Bearer ${fixture.credentials.token}` ? 'terminal' as const : 'account' as const,
        tokenEpoch: 0 };
      const workflowProposal = proposal.success && proposal.data.workflowActionOrigin ? proposal.data : undefined;
      const parentBinding = workflowProposal?.executionAuthorization?.binding;
      const requesterAuthentication = parentBinding && 'authentication' in parentBinding
        ? parentBinding.authentication : authentication;
      if (workflowProposal) {
        // Home verifies the installed publisher, then mints the exact child;
        // its parent requester root is authority input, never a child relay.
        expect(verifyMachineInstallationProof({ publicKey: fixture.pair.publicKey,
          proof: MachineInstallationProofV1Schema.parse(workflowProposal.installationProof), payload: {
            version: 1, accountId: 'alice', machineId: machine.id, installationId: installation.installationId,
            externalActionOrigin: { homeId: 'srv_home', actionId, requestId: requireEnvelopeRequestId(envelope.requestId),
              requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
              origin: workflowProposal.workflowActionOrigin! },
          } })).toBe(true);
        const parent = workflowProposal.executionAuthorization;
        if (parent) expect(roots.get(parent.token)?.binding).toEqual(parent.binding);
        workflowParent = parent;
      }
      const deploymentPreparationAdmission = projectExternalActionDeploymentPreparationEnvelopeAdmissionV1({ actionId, envelope });
      const authorization = (proposal.success && !workflowProposal ? proposal.data.executionAuthorization : undefined) ?? ExternalActionExecutionAuthorizationV1Schema.parse({
        // Home tokens bind the complete envelope. Repeated Ask keeps its request
        // identity while E2EE reseals it, so those roots must remain distinct.
        v: 1, token: `native-${actionId}-${envelope.requestId}-${computeExternalActionRequestEnvelopeDigestV1(envelope)}`, binding: {
          accountId: 'alice', authentication: requesterAuthentication, serverIdentityId: 'srv_home',
          machineId: machine.id, custodianAccountId: 'alice', installationId: installation.installationId,
          admittedMachineRole: 'manage',
          accountEncryptionMode: fixture.accountEncryptionMode, actionId, requestId: envelope.requestId, target: envelope.target,
          requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
          ...(envelope.v === 2 && envelope.machineRuntimeDemand !== undefined
            ? { machineRuntimeDemand: envelope.machineRuntimeDemand } : {}),
          ...(deploymentPreparationAdmission ? { deploymentPreparationAdmission } : {}),
          ...(proposal.success && proposal.data.workflowActionOrigin ? { workflowActionOrigin: proposal.data.workflowActionOrigin } : {}),
          ...(actionId === 'approval.request.decide'
            ? { approvalDecisionAdmission: projectExternalActionApprovalDecisionEnvelopeAdmissionV1({ actionId, envelope }) } : {}),
        },
      });
      roots.set(authorization.token, authorization);
      if (path === bindExternalActionExecutionAuthorizationHttpPathV1(actionId))
        return { status: 200, data: authorization };
      if (path !== `/v1/actions/${actionId}`) throw new Error(`Unexpected native Home HTTP path: ${path}`);
      delivery = { actionId, origin: authorization.binding.workflowActionOrigin ? 'workflow' : 'ordinary', phase: 'delivering' };
      homeActionDeliveries.push(delivery);
      if (authorization.binding.workflowActionOrigin) {
        // Observe the actual Home delivery with the installed recipient's key.
        // The admitted finite Setup leaf carries its invocation codec, without Account credentials.
        const codec = openManagedControllerActionCodecV1({ authorization,
          machineId: machine.id, installationId: installation.installationId,
          serverIdentityId: 'srv_home', installationPrivateKey: fixture.pair.secretKey });
        const requester = openExternalActionRequesterAccountContextV1({ authorization,
          purpose: { kind: 'external_action' }, machineId: machine.id, installationId: installation.installationId,
          serverIdentityId: 'srv_home', installationPrivateKey: fixture.pair.secretKey });
        const parentBinding = workflowParent?.binding;
        workflowRequesterCustody.push({ codecOpened: codec !== null,
          requesterCredentialsAbsent: requester === null,
          parentAuthentication: Boolean(parentBinding && 'authentication' in parentBinding
            && parentBinding.authentication.kind === 'account' && 'authentication' in authorization.binding
            && createCanonicalJsonSigningInput(authorization.binding.authentication)
              === createCanonicalJsonSigningInput(parentBinding.authentication)) });
      }
      const response = await fixture.receive({ actionId, envelope, authorization,
        ...(authorization.binding.workflowActionOrigin ? { authority: 'account_automation' } : {}) });
      delivery.phase = 'settled';
      const parsedResponse = ExternalActionResponseEnvelopeV1Schema.safeParse(response);
      if (parsedResponse.success) {
        delivery.executionOk = parsedResponse.data.execution.ok;
        const code = parsedResponse.data.execution.ok ? undefined : parsedResponse.data.execution.errorCode;
        if (typeof code === 'string' && /^[a-zA-Z0-9_.:-]+$/u.test(code)) delivery.errorCode = code;
      }
      return { status: 200, data: response };
      } catch (error) {
        if (delivery) delivery.phase = 'rejected';
        const response = error && typeof error === 'object' && 'response' in error ? error.response : null;
        console.error('Native Home HTTP boundary refused', { path,
          frames: error instanceof Error ? error.stack?.split('\n').slice(1, 5) : undefined,
          errorClass: error instanceof Error ? error.name : typeof error,
          status: response && typeof response === 'object' && 'status' in response && typeof response.status === 'number'
            ? response.status : null,
          code: error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
            && /^[a-zA-Z0-9_.:-]+$/u.test(error.code) ? error.code : null });
        throw error;
      }
    });
    onTestFinished(() => { homeHttp.mockRestore(); homeFetch.mockRestore(); });
    phase = 'start_installed_native_runtime';
    await fixture.startInstalledRuntime();
    if (exerciseInstalled) {
      try { await exerciseInstalled(fixture, authorization => roots.set(authorization.token, authorization), accountChannel); }
      finally { await fixture.dispose(); }
      return;
    }
  }
  const executor = nativeConfirmed ? fixture.publicExecutor : createActionExecutor(nativeDeps);
  const hostContext = (actionId: string): RpcActionExecutorContext => ({ surface: 'ui', authority: 'present_user',
    actionCaller: { kind: 'host' }, runtimeAccountId: 'alice', serverIdentityId: 'srv_home',
    actionRequestId: actionId, externalActionTarget: { kind: 'machine', machineId: machine.id },
    signal: new AbortController().signal });
  let nativeOperationId: string | undefined;
  try {
    phase = 'plan_native_effects';
    const planned = await executor.execute('machines.setup.plan', { homeId: 'srv_home', machineId: machine.id, mode: 'effects', sources,
      ...(excludedToSelected ? { exclusions: [], removeItemKeys: [] } : {}),
    }, nativeConfirmed ? hostContext('machines.setup.plan') : context('machines.setup.plan'));
    if (!planned.ok) throw new Error(`Public software Plan failed: ${planned.errorCode} (${planned.error})`);
    const reviewed = MachineSetupPlanResultV1Schema.parse(planned.result);
    if (excludedToSelected) expect(reviewed).toMatchObject({ exclusions: [], removeItemKeys: [] });
    if (!reviewed.recipePlans?.length) throw new Error('Effects Plan must produce the exact native review');
    expect(reviewed.recipePlans[0]?.plan.nativeFacts).toMatchObject([{ status: 'drifted', facts: {
      packages: [{ name: 'jq', present: initiallyPresent }],
    } }]);
    const input = MachineSetupApplyInputV1Schema.parse({ homeId: 'srv_home', machineId: machine.id, targets: [{
      homeId: 'srv_home', machineId: machine.id, sources: reviewed.sources, desiredRevision: reviewed.desiredRevision,
      recipePlans: reviewed.recipePlans,
      ...(excludedToSelected ? { exclusions: reviewed.exclusions,
        ...('removeItemKeys' in reviewed ? { removeItemKeys: reviewed.removeItemKeys } : {}) } : {}),
    }] });
    const rpcContext = nativeConfirmed ? hostContext('machines.setup.apply') : context('machines.setup.apply');
    const installContext: RpcActionExecutorContext = { ...rpcContext,
      ...(!nativeConfirmed ? { signExternalActionApprovalInput: (args: Parameters<NonNullable<RpcActionExecutorContext['signExternalActionApprovalInput']>>[0]) => signExternalActionApprovalInputV1({
        ...args, authorizationToken: rpcContext.externalActionExecutionAuthorization!.token,
        privateKey: fixture.pair.secretKey,
      }) } : {}),
    };
    if (scenario === 'first-forged-absent') {
      const firstPresence = Object.fromEntries((reviewed.sources[0]?.setup.items ?? []).filter(item => item.kind !== 'app')
        .map(item => [createCanonicalJsonSigningInput(item), 'absent']));
      for (const target of [
        { ...input.targets[0], sourceFacts: { direct: { firstPresence } } },
        { ...input.targets[0], sources: reviewed.sources.map(source => ({ ...source, alreadyPresentAtFirstApply: firstPresence })) },
      ]) {
        expect(await executor.execute('machines.setup.apply', { ...input, targets: [target] }, rpcContext))
          .toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
      }
      expect(JSON.parse(await readFile(statePath, 'utf8'))).toEqual({ installed: true, version: '0.5', effects: [] });
      expect(machine.metadataVersion).toBe(0);
      expect(rootLaunches).toEqual([]);
    }
    if (scenario === 'first-arrived') {
      // The native OS boundary changes after the public Plan. This package
      // belongs to the person even though the reviewed snapshot was absent.
      await writeFile(statePath, JSON.stringify({ installed: true, version: '0.5', effects: [] }));
      initiallyPresent = true;
    }
    phase = 'execute_native_effects';
    let result = nativeConfirmed ? await executor.execute('machines.setup.apply', input,
      withNativeConfirmation('machines.setup.apply', input, installContext)) : await operations.observeExecution({ actionId: 'machines.setup.apply', input,
      actionRequestId: installContext.actionRequestId, rpcContext: installContext,
      execute: owned => executor.execute('machines.setup.apply', input,
        withNativeConfirmation('machines.setup.apply', input, { ...installContext, ...owned })),
    });
    if (askAndDecide && !nativeConfirmed) {
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { kind: 'approval_request_created', artifactId: expect.any(String) } });
      if (!result.ok || !result.result || typeof result.result !== 'object'
        || !('artifactId' in result.result) || typeof result.result.artifactId !== 'string')
        throw new Error('Native Ask must return its persisted Artifact');
      const artifactId = result.result.artifactId;
      expect(await fixture.readInstalled()).toMatchObject({ installed: false, version: null, effects: [] });
      expect(metadataWrites).toHaveLength(0);
      const retry = withNativeConfirmation('machines.setup.apply', input, installContext);
      expect(await executor.execute('machines.setup.apply', input, {
        ...retry, presentUserConfirmation: decodeNativeConfirmation(retry),
      })).toEqual(result);
      expect(artifacts.size).toBe(1);
      const decision = await executor.execute('approval.request.decide', { artifactId, decision: 'approve',
        serverIdentityId: 'srv_home', originServerId: configuration.activeServerId }, hostContext('native-approval-decision'));
      const executionFailure = decision.ok && decision.result && typeof decision.result === 'object'
        && 'execution' in decision.result ? decision.result.execution : null;
      const executionErrorCode = executionFailure && typeof executionFailure === 'object' && 'errorCode' in executionFailure
        && typeof executionFailure.errorCode === 'string' ? executionFailure.errorCode : null;
      expect(decision, executionErrorCode ? JSON.stringify({ stage: 'native_approval_execution_failed',
        errorCode: executionErrorCode,
        details: executionFailure && typeof executionFailure === 'object' && 'details' in executionFailure ? executionFailure.details : undefined,
        receiverFailures: await fixture.readActionFailureDiagnostics(),
        workflow: fixture.workflowDiagnostic() }) : JSON.stringify(decision))
        .toMatchObject({ ok: true, result: { status: 'executed', execution: { ok: true } } });
      if (!decision.ok || !decision.result || typeof decision.result !== 'object'
        || !('execution' in decision.result)) throw new Error('Native approval must execute the original operation');
      const execution = decision.result.execution;
      if (!execution || typeof execution !== 'object' || !('ok' in execution) || execution.ok !== true
        || !('result' in execution)) throw new Error('Native approval must return the native effect');
      result = { ok: true, result: execution.result };
      expect(artifacts.size).toBe(1);
      const store = createCliApprovalsArtifactStore({ credentials: osStore.credentials!, serverId: configuration.activeServerId });
      expect(await store.approvalsGet({ artifactId, serverId: configuration.activeServerId })).toMatchObject({ status: 'executed' });
    }
    if (nativeConfirmed) {
      // The exact native UI review answers saved Require at the receiving owner.
      // Non-native callers above retain their persisted Ask/decision journey.
      expect(approvalArtifacts).toHaveLength(0);
      expect(artifacts.size).toBe(0);
    }
    if (nativeConfirmed && result.ok) {
      phase = 'wait_for_admitted_native_operation';
      const receipt = ManagedMachineActionOutputSchemasV1['machines.setup.apply'].parse(result.result);
      const credentials = fixture.credentials;
      if (!credentials) throw new Error('Native operation observation requires its original Account');
      // Apply and approval replay acknowledge admission before the native
      // effect finishes. Observe the original receipt through Home and the
      // installed V2 wait owner before asserting its physical outcome.
      const settled = ActionOperationGetV1ResponseSchema.parse(await callExactMachineRpc({ credentials,
        serverUrl: 'https://native-software.invalid', machineId: machine.id,
        method: ACTION_OPERATION_RPC_METHODS_V2.get,
        request: { operationId: receipt.operationId, waitForTerminal: true },
        timeoutMs: null, ...(installContext.signal ? { signal: installContext.signal } : {}),
      }));
      const errorCode = settled.kind === 'found' ? settled.operation.error?.errorCode : undefined;
      expect(settled, JSON.stringify({ stage: 'original_native_operation_settled',
        errorCode: errorCode && /^[a-zA-Z0-9_.:-]+$/u.test(errorCode) ? errorCode : undefined,
        ...(settled.kind === 'found' && settled.operation.state !== 'succeeded'
          ? { receiverFailures: await fixture.readActionFailureDiagnostics() } : {}),
        workflow: fixture.workflowDiagnostic() }))
        .toMatchObject({ kind: 'found', operation: { state: 'succeeded' } });
      if (askAndDecide) {
        phase = 'verify_workflow_requester_custody';
        expect(workflowRequesterCustody).toEqual([{ codecOpened: true, requesterCredentialsAbsent: true, parentAuthentication: true }]);
      }
    }
    if (scenario !== 'apt-none') {
      expect(result, result.ok ? undefined : `machine_setup_apply_failed:${result.errorCode ?? 'unclassified'}`)
        .toMatchObject({ ok: true });
      expect(JSON.parse(await readFile(statePath, 'utf8'))).toMatchObject({ installed: true, version: '1.0', effects: [manager === 'brew' ? 'brew' : 'apt-get'],
        ...(manager === 'apt' ? { updatesChecks: 1 } : {}) });
      if (nativeConfirmed) expectNativeMetadataPublications();
      else {
        expect(machine.metadataVersion).toBe(1);
        expect(metadataWrites).toHaveLength(1);
      }
      if (nativeConfirmed) {
        phase = 'read_settled_system_task';
        const operationId = ManagedMachineActionOutputSchemasV1['machines.setup.apply'].parse(result.ok ? result.result : null).operationId;
        const observationContext = context('machines.setup.apply');
        const settled = await operations.handlers.getV2({ operationId }, observationContext);
        expect(settled).toMatchObject({ kind: 'found', operation: { state: 'succeeded' } });
        const children = await operations.handlers.listV2({}, observationContext);
        const child = children.items.find(value => value.operationId !== operationId && value.domainRef?.kind === 'machineSetup');
        expect(child).toMatchObject({ state: 'succeeded', domainRef: {
          kind: 'machineSetup', setupTask: { id: expect.any(String), taskKind: 'machine.setup.apply.v1' },
        } });
        if (child?.domainRef?.kind !== 'machineSetup' || !child.domainRef.setupTask)
          throw new Error('Confirmed install must settle its actual system task');
        nativeOperationId = child.operationId;
        expect(await getLiveSystemTasksRunnerAdapter().wait({ taskId: child.domainRef.setupTask.id }))
          .toMatchObject({ ok: true, data: { operationId: child.operationId } });
        phase = 'rejoin_repeated_native_invocation';
        // A later preference applies to a new request, not to the already
        // completed invocation. Rejoining must happen before fresh policy.
        explicitAsk = true;
        const staleReviewInput = { ...input, targets: input.targets.map(target => ({ ...target,
          desiredRevision: target.desiredRevision + 1 })) };
        const fresh = withNativeConfirmation('machines.setup.apply', staleReviewInput, { ...installContext, actionsSettings: readActionsSettings() });
        // A transport decode creates another object. The stale native review
        // is not fresh consent; receipt observation belongs to the existing
        // invocation before another policy decision can be requested.
        const repeatedContext = { ...fresh, presentUserConfirmation: decodeNativeConfirmation(fresh) };
        expect(await executor.execute('machines.setup.apply', input, repeatedContext)).toEqual(result);
        expect(await operations.handlers.getV2({ operationId }, observationContext)).toEqual(settled);
        expect(await executor.execute('machines.setup.apply', staleReviewInput, {
          ...fresh, presentUserConfirmation: decodeNativeConfirmation(fresh),
        })).toMatchObject({ ok: false, errorCode: 'action_request_input_conflict' });
        expect(JSON.parse(await readFile(statePath, 'utf8'))).toMatchObject({ installed: true, version: '1.0', effects: ['apt-get'] });
        expectNativeMetadataPublications();
        expect(approvalArtifacts).toHaveLength(0);
      }
    } else {
      expect(result).toMatchObject({ ok: false, errorCode: 'mode_none' });
      expect(JSON.parse(await readFile(statePath, 'utf8'))).toEqual({ installed: false, version: null, effects: [] });
      expect(machine.metadataVersion).toBe(0);
    }
    if (scenario === 'apt' || firstPresence || excludedToSelected || nativeConfirmed) {
      expect(rootLaunches).toEqual([{ executable: 'sudo', args: ['-n', '-u', 'root', '--', resolveInstalledMachineEffectCli(),
        'machine', 'effect-internal', `--operation-id=${nativeOperationId ?? 'public-package-operation'}`, `--installation-id=${installation.installationId}`] }]);
      expect(rootPlans).toEqual([reviewed.recipePlans.map(entry => ({ plan: entry.plan }))]);
    } else expect(rootLaunches).toEqual([]);
    if (excludedToSelected) {
      expect(reviewed.exclusions).toEqual([]);
      const current = await client.getMachineSetupDesiredSnapshot();
      if (current.status !== 'ready') throw new Error('Update must publish its selected source');
      expect(current.policy.exclusions).toEqual([]);
      expect(current.policy.sourceFacts).toBeUndefined();
    }
    phase = 'native_apply_complete';
    if (firstPresence) {
      const current = await client.getMachineSetupDesiredSnapshot();
      if (current.status !== 'ready') throw new Error('Successful Apply must publish its source');
      expect(Object.values(current.policy.sourceFacts?.direct?.firstPresence ?? {})).toEqual([initiallyPresent ? 'present' : 'absent']);
      expect(current.policy.sources[0]).not.toHaveProperty('alreadyPresentAtFirstApply');
      if (scenario === 'first-absent' || scenario === 'first-absent-e2ee') {
        const again = await executor.execute('machines.setup.plan', { homeId: 'srv_home', machineId: machine.id, mode: 'effects',
          sources: [{ kind: 'bundledPreset', ref: { pluginId: 'com.example.public-package', localId: 'bundle', revision: '1' },
            setup: { items: [{ kind: 'softwareRecipe', selection: {
              ref: { pluginId: 'com.example.public-package', recipeId: 'jq', revision: '1' }, inputs: {},
            } }] } }, ...current.policy.sources],
        }, context('machines.setup.plan', 'second-plan'));
        if (!again.ok) throw new Error(`Second public Plan failed: ${again.errorCode}`);
        const second = MachineSetupPlanResultV1Schema.parse(again.result);
        const secondInput = MachineSetupApplyInputV1Schema.parse({ homeId: 'srv_home', machineId: machine.id, targets: [{
          homeId: 'srv_home', machineId: machine.id, desiredRevision: second.desiredRevision,
          sources: second.sources, recipePlans: second.recipePlans,
        }] });
        const secondContext = context('machines.setup.apply', 'second-apply');
        expect(await operations.observeExecution({ actionId: 'machines.setup.apply', input: secondInput,
          actionRequestId: secondContext.actionRequestId, rpcContext: secondContext,
          execute: owned => executor.execute('machines.setup.apply', secondInput,
            withNativeConfirmation('machines.setup.apply', secondInput, { ...secondContext, ...owned })),
        })).toMatchObject({ ok: true });
        const saved = await client.getMachineSetupDesiredSnapshot();
        if (saved.status !== 'ready') throw new Error('Second attachment must publish');
        expect(Object.values(saved.policy.sourceFacts?.['bundled:com.example.public-package/bundle']?.firstPresence ?? {})).toEqual(['absent']);
        expect(Object.values(saved.policy.sourceFacts?.direct?.firstPresence ?? {})).toEqual(['absent']);
        expect(JSON.parse(await readFile(statePath, 'utf8'))).toEqual({ installed: true, version: '1.0', effects: ['apt-get'], updatesChecks: 2 });
        expect(machine.metadataVersion).toBe(2);
        expect(metadataWrites).toHaveLength(2);
        expect(rootLaunches).toHaveLength(2);
        expect(rootPlans[1]).toEqual(second.recipePlans?.map(entry => ({ plan: entry.plan })));
      }
      if (!removing && !initiallyPresent) return;
      const saved = await client.getMachineSetupDesiredSnapshot();
      if (saved.status !== 'ready') throw new Error('Removal needs its real target-owned current copy');
      const item = saved.policy.sources.flatMap(source => source.setup.items ?? []).find(item => item.kind !== 'app');
      if (!item) throw new Error('The installed item must remain in desired setup until removal');
      const itemKey = createCanonicalJsonSigningInput(item);
      const detach = { homeId: 'srv_home', machineId: machine.id, mode: 'effects' as const,
        sources: [{ kind: 'direct' as const, setup: {} }], exclusions: [],
      };
      const unticked = await executor.execute('machines.setup.plan', { ...detach, removeItemKeys: [] }, context('machines.setup.plan', 'remove-preview'));
      if (!unticked.ok) throw new Error(`Removal preview failed: ${unticked.errorCode}`);
      expect(MachineSetupPlanResultV1Schema.parse(unticked.result).removalOffers).toMatchObject([
        { itemKey, selected: false, ...(initiallyPresent ? { status: 'notEligible', reason: 'preExisting' } : { status: 'eligible' }) },
      ]);
      const selected = await executor.execute('machines.setup.plan', { ...detach, removeItemKeys: [itemKey] }, context('machines.setup.plan', 'remove-selected'));
      if (initiallyPresent) {
        expect(selected).toMatchObject({ ok: false, errorCode: 'remove_unsupported' });
        expect(JSON.parse(await readFile(statePath, 'utf8'))).toEqual({ installed: true, version: '1.0', effects: ['apt-get'], updatesChecks: 1 });
        expect(machine.metadataVersion).toBe(1);
      } else {
        if (!selected.ok) throw new Error(`Declared removal Plan failed: ${selected.errorCode}`);
        const removal = MachineSetupPlanResultV1Schema.parse(selected.result);
        expect(removal.recipePlans).toEqual([]);
        expect(removal.removalPlans?.map(entry => entry.plan.steps.map(step => step.id))).toEqual([['remove-jq']]);
        const removeInput = { homeId: 'srv_home', machineId: machine.id, sources: removal.sources,
          desiredRevision: removal.desiredRevision, exclusions: removal.exclusions,
          removeItemKeys: removal.removeItemKeys, removalPlans: removal.removalPlans,
        };
        const removeContext = context('machines.setup.remove', 'remove-exact');
        const terminalCount = nativeTerminal.launches.length;
        expect(await operations.observeExecution({ actionId: 'machines.setup.remove', input: removeInput,
          actionRequestId: removeContext.actionRequestId, rpcContext: removeContext,
          execute: owned => executor.execute('machines.setup.remove', removeInput,
            withNativeConfirmation('machines.setup.remove', removeInput, { ...removeContext, ...owned })),
        })).toMatchObject({ ok: true });
        expect(JSON.parse(await readFile(statePath, 'utf8'))).toEqual({ installed: false, version: null, effects: ['apt-get', 'dpkg:remove'], updatesChecks: 2 });
        expect(nativeTerminal.launches).toHaveLength(terminalCount);
        const removed = await client.getMachineSetupDesiredSnapshot();
        if (removed.status !== 'ready') throw new Error('Declared removal must publish its resulting desired copy');
        expect(removed.policy.sources.flatMap(source => source.setup.items ?? [])).toEqual([]);
        expect(removed.policy.sourceFacts).toBeUndefined();
        expect(rootLaunches).toHaveLength(2);
        expect(rootPlans[1]).toEqual(removal.removalPlans?.map(entry => ({ plan: entry.plan })));
        expect(machine.metadataVersion).toBe(2);
        expect(metadataWrites).toHaveLength(2);
      }
    }
  } finally {
    await fixture.dispose();
  }
}
