import { projectExternalActionMachineRuntimeDemandV1 } from '@happier-dev/protocol/actions/actionSpecs';
import { AccountStoredContentUpgradeRequiredV1Schema } from '@happier-dev/protocol/clientCompatibility/upgradeRequiredV1';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { artifactReadResponse } from '@/testkit/http/artifactHome';
import { bootstrapAccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { isDeploymentChildRootActionIdV1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import { projectAccountRowReadResponse } from '@/testkit/http/projectAccountRows';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import tweetnacl from 'tweetnacl';
import axios from 'axios';
import type { RpcActionExecutorContext } from '@/rpc/handlers/_actionDispatchAdapter';
import { projectRequesterAccountActionAuthorization } from '../sessionEncryption/requesterSessionCredentials';
import { createProjectAccountRowCipherV1 } from '@happier-dev/protocol/projects/projectAccountRowCipherV1';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions';
import { createRegistryHostV1, type RegistrySourceDescriptorV1 } from '@happier-dev/protocol/registries';
import { deriveMarketplaceSourceId } from '@happier-dev/protocol/marketplace';

import {
  createActionExecutor,
  EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES,
  computeExternalActionRequestEnvelopeDigestV1,
  measureExternalActionResponseEnvelopeUtf8BytesV1,
  openExternalActionResponseV2,
  sealExternalActionRequestV2,
  verifyExternalActionApprovalInputV1,
} from '@happier-dev/protocol/actions';
import { API_TOKEN_FULL_GRANT_V1, ApiTokenGrantV1Schema, buildBackendTargetKeyV2, type JsonValue } from '@happier-dev/protocol';
import { createUnavailableActionTransportDeps as createUnavailableHostActionDeps } from '@/testkit/actionTransportDeps';

import {
  executeExternalAction,
  type ExternalActionExecutor,
  type ResolveExternalActionTarget,
} from './executeExternalAction';
import { createDaemonExternalActionTargetResolver } from './daemonExternalActionTargetResolver';
import { SessionActionRpcOriginV1Schema } from '@happier-dev/protocol/socketRpc';
import { deriveSessionInputActionRequestAttributionV1 } from '@happier-dev/protocol/actions/actionRequestAttributionV1';
import { resolveSessionRoleRpcOrigin } from '@/session/actions/sessionRoleRpcOrigin';
import { ApprovalRequestV2Schema, resolveApprovalExecutor, type ApprovalRequest } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { approvalArtifactBodyMatchesHeaderV1, buildApprovalRequestArtifactHeaderV1, buildTargetActionApprovalArtifactHeaderV1, listApprovalArtifactsV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { TargetActionApprovalRequestV1Schema } from '@happier-dev/protocol/approvals/targetActionApprovalRequestV1';
import { listArtifactHeadersV1 } from '@happier-dev/protocol/artifacts/artifactListSelectionV1';
import { decideApprovalRequestTransition } from '@happier-dev/protocol/approvals/approvalRequestTransition';
import { ActionsSettingsV1Schema, normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER, EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER,
  ExternalActionExecutionAuthorizationV1Schema, ExternalActionServerPrincipalV1Schema, projectExternalActionExecutionResultV1,
  projectExternalActionHttpError, ExternalActionHttpErrorSchema,
  parseExternalActionDaemonDispatchResult, projectExternalActionManagedAdmissionV1,
  projectDeploymentNativeAdmissionV1, projectExternalActionDeploymentMetadataEnvironmentIdV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { classifyServerEndpointError } from '@/api/client/classifyServerEndpointError';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { RpcHandlerContext } from '@/api/rpc/types';
import { registerApprovalRpcHandlers } from '@/rpc/handlers/approvals';
import { createCliActionExecutorHarness } from '@/session/actions/createCliActionExecutorHarness';
import { createDaemonApprovalExecutionAuthorizationPreparer } from './approvalExecutionAuthorization';
import { createDaemonApprovalExecutionOriginCurrentness } from './daemonExternalActionTargetResolver';
import { ManagedAdmissionComputeInputV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { ManagedMachineEnrollmentIdentityV1Schema, ManagedMachineFullV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, decodePlainArtifactStoredContent } from '@happier-dev/protocol';
import { getActiveAccountSettingsSnapshot, setActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { prepareRequesterAccountActionContext } from '../sessionEncryption/requesterAccountActionProjection';
import { sealExternalActionRequesterAccountContextV1, sealManagedControllerActionCodecV1, type ExternalActionRequesterInvocationV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { createCliActionDeps } from '@/session/actions/createCliActionDeps';
import { ProjectAccountRowV1Schema, ProjectAccountRowMutationRequestV1Schema } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { encodeStoredCredentials } from '@/persistence';
import { prepareAccountSettingsV2Content } from '@/settings/accountSettings/updateAccountSettingsV2WithRetry';
import { computeAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import { resetServerFeaturesClientForTests } from '@/features/serverFeaturesClient';
import { registerSessionAgentTransitionRpcHandlers } from '@/rpc/handlers/sessionAgentTransition';
import { createEncryptedRpcTestClient } from '@/rpc/handlers/encryptedRpc.testkit';
import { createCliActionExecutor } from '@/session/actions/createCliActionExecutor';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { logger } from '@/ui/logger';
import { SessionStatusActionResultV1Schema } from '@happier-dev/protocol/sessions/control/contract';
import { projectSessionBoardGetResultV1, SessionBoardGetInputV1Schema } from '@happier-dev/protocol/sessions/board/actions';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { projectApiTokenSessionSpawnAdmissionV1 } from '@happier-dev/protocol/auth/apiTokenGrant';
import { computeActionInputApprovalDigestV1 } from '@happier-dev/protocol/actions/decisionAuthority';
import { createDeploymentEnvironmentDetailV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1, DeploymentBindingsSetStorageInputV1Schema,
  type MachineSecretGrantV1 } from '@happier-dev/deployment-protocol';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { sealSavedSecretResourceStoredContentV1 } from '@happier-dev/protocol/account/settings/savedSecretResourceContentV1';
import { createResourceDataKey } from '@/api/encryption/resourceDataKey';
import { encodeBase64, encryptWithDataKey, getRandomBytes } from '@/api/encryption';
import * as installationIdentity from '@/daemon/identity/store';
import { createRequesterBoundDeploymentActionDeps } from './deploymentActionDeps';
import { createOwnServerDeploymentRuntimeForHost } from '@/deployments/targets/ownServer/ownServerDeploymentHostRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { selectHostRequesterExecutionIdentity } from '@/daemon/agentIsolation/agentIsolationLaunchPolicy';
import { prepareEnvironmentSecretBindingsForLaunch } from '@/deployments/secrets/prepareEnvironmentSecretBindingsForLaunch';
import { verifyExternalActionExecutionAuthorizationCurrent } from '@/api/externalActionExecutionAuthorization';
import { deriveAccountMachineKeyFromRecoverySecret } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { settleActionOutput } from '@happier-dev/protocol/actions/executor/resultProjection';

let currentnessChannel: Awaited<ReturnType<typeof createRequesterCurrentnessSocketHarness>>;
beforeEach(async () => { currentnessChannel = await createRequesterCurrentnessSocketHarness(); });
afterEach(async () => { await currentnessChannel.close(); });

const principal = {
  accountId: 'account-1',
  principalId: 'principal-1',
  credentialId: 'credential-1',
  grant: API_TOKEN_FULL_GRANT_V1,
  authority: 'account_automation',
} as const;

const SESSION_SPAWN_PENDING_RESULT = {
  type: 'pending',
  retryWithSameCreationKey: true,
  outcome: 'accepted',
} as const;


// The reviewed dedicated-server intent required by the canonical acquisition owner.
const enrollmentIdentity = ManagedMachineEnrollmentIdentityV1Schema.parse({
  kind: 'dedicatedDaemonUser', username: 'happier', serviceMode: 'user',
  role: 'server', adminAccessAtCreation: 'preauthorized',
});

function createSessionStatusResult(title: string) {
  return SessionStatusActionResultV1Schema.parse({ session: { id: 'session-1', createdAt: 0, updatedAt: 0,
    active: false, activeAt: 0, encryption: null, title } });
}

function createExactLimitMultibyteResult() {
  const emptyResponse = {
    v: 1,
    actionId: 'session.status.get',
    requestId: 'request-limit',
    execution: { ok: true, result: createSessionStatusResult('a') },
  } as const;
  const fixedBytes = measureExternalActionResponseEnvelopeUtf8BytesV1(emptyResponse) - 1;
  const multibyteMarker = 'é';
  const markerBytes = new TextEncoder().encode(multibyteMarker).byteLength;
  return createSessionStatusResult('a'.repeat(
    EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES - fixedBytes - markerBytes,
  ) + multibyteMarker);
}

describe('executeExternalAction', () => {
  it('rejects a generic operation receipt for an Action without an operation', () => {
    expect(settleActionOutput('session.message.send', { ok: true,
      result: { status: 'accepted', operationId: 'foreign-operation', machineId: 'machine' } }))
      .toMatchObject({ ok: false, errorCode: 'invalid_action_output' });
  });

  it.each(['agent', 'mcp'] as const)('projects a real %s operation admission through signed ingress before the native launch settles', async surface => {
    const actionId = 'session.spawn_new';
    const target = { kind: 'machine' as const, machineId: 'admission-machine' };
    const accountPrincipal = { accountId: 'admission-account', authentication: { kind: 'account' as const, tokenEpoch: 0 },
      authority: 'present_user' as const };
    const keys = tweetnacl.sign.keyPair();
    const input = { creationKey: `signed-${surface}`, executionTarget: { serverId: 'srv_admission', machineId: target.machineId },
      directory: { kind: 'managed' as const }, agentTarget: { kind: 'agent' as const,
        identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } };
    const envelope = { v: 1 as const, requestId: `signed-${surface}`, target, input };
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: `proof-${surface}`, binding: {
      serverIdentityId: 'srv_admission', accountId: accountPrincipal.accountId, authentication: accountPrincipal.authentication,
      custodianAccountId: accountPrincipal.accountId, machineId: target.machineId, installationId: 'admission-installation',
      admittedMachineRole: 'manage', accountEncryptionMode: 'plain', actionId, requestId: envelope.requestId, target,
      requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
    } });
    const operations = createHostActionOperationRuntime({ serverId: 'srv_admission', machineId: target.machineId,
      resolveAccountId: async () => accountPrincipal.accountId, generateOperationId: () => `operation-${surface}` });
    let release!: () => void;
    const nativeGate = new Promise<void>(resolve => { release = resolve; });
    onTestFinished(async () => {
      release();
      await operations.runner.waitForTerminal({ accountId: accountPrincipal.accountId, machineId: target.machineId }, `operation-${surface}`);
    });
    let launched = false;
    const settings = ActionsSettingsV1Schema.parse({ v: 1, scopedApprovalPreferences: [{ actionId,
      scope: { kind: 'machine', machineId: target.machineId }, approvalRequiredSurfaces: [], approvalWaivedSurfaces: ['agent', 'mcp'],
    }] });
    // Constructed host input, as in the Agent-start owner's contract tests;
    // the real policy still admits the selection and its ordinary depth.
    const agentStartContext = { caller: { kind: 'originless', runId: 'host-agent-caller', runDepth: 0 },
      baseline: { machineId: target.machineId, directory: '/workspace' }, ledSubtreeSessionIds: [],
      workDepthLimit: 4, roles: {}, callerPermissionCeiling: 'default',
    } satisfies NonNullable<ActionExecutorContext['agentStartContext']>;
    const realExecutor = createActionExecutor({ ...createUnavailableHostActionDeps(), runActionOperation: operations.runActionOperation,
      // The spawned Agent process is the external boundary; Action policy,
      // operation admission, terminal storage and output projection stay real.
      sessionSpawnNew: async request => {
        launched = true;
        await nativeGate;
        return { type: 'success', disposition: 'created', sessionId: 'created-session', executionTarget: request.executionTarget,
          organizationPlacement: { folderId: null, tagIds: [] }, initialInput: { status: 'notRequested' } };
      },
    });
    const executor: ExternalActionExecutor = { execute: (id, value, context) => realExecutor.execute(id, value,
      { ...context, actionsSettings: settings, agentStartContext }) };
    try {
      const result = await executeExternalAction({ actionId, envelope, principal: accountPrincipal, surface,
        executionAuthorization: authorization, currentMachineId: target.machineId, currentAccountId: accountPrincipal.accountId,
        currentServerId: 'srv_admission', currentInstallationId: 'admission-installation',
        externalActionMachineRequestPrivateKey: keys.secretKey, verifyExecutionAuthorization: async () => true,
        resolveTarget: createDaemonExternalActionTargetResolver({ credentials: { token: 'fixture', encryption: null } }), executor });
      expect(result, JSON.stringify(result)).toMatchObject({ kind: 'response', response: { execution: { ok: true,
        result: { status: 'accepted', operationId: `operation-${surface}`, machineId: target.machineId } } } });
    } finally { release(); }
    const terminal = await operations.runner.waitForTerminal({ accountId: accountPrincipal.accountId, machineId: target.machineId }, `operation-${surface}`);
    expect(launched).toBe(true);
    expect(terminal).toMatchObject({ state: 'succeeded', result: { type: 'success', sessionId: 'created-session' } });
  });

  it.each(['omitted-projection', 'omitted-setup-fact', 'invented-setup-fact'] as const)(
    'rejects %s before opening encrypted spawn setup to effects', async variant => {
      const target = { kind: 'machine' as const, machineId: 'machine-1' };
      const material = { type: 'dataKey' as const, machineKey: new Uint8Array(32).fill(23) };
      const spawnPrincipal = { ...principal, credentialId: '00000000-0000-4000-8000-000000000001' };
      const binding = { serverIdentityId: 'srv_home', accountId: spawnPrincipal.accountId,
        credentialId: spawnPrincipal.credentialId, actionId: 'session.spawn_new', requestId: variant, target };
      const spawn = { executionTarget: { serverId: binding.serverIdentityId, machineId: target.machineId },
        agentTarget: { kind: 'agent' as const, identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
        directory: { kind: 'managed' as const }, ...(variant === 'invented-setup-fact' ? {} : {
          machineSetupPlanInput: { homeId: binding.serverIdentityId, machineId: target.machineId,
            sources: [{ kind: 'direct' as const, setup: {} }] },
        }) };
      const facts = projectApiTokenSessionSpawnAdmissionV1(spawn);
      const { machineSetupRequested: _setup, ...withoutSetup } = facts;
      const envelope = sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1,
        binding, material, input: spawn, randomBytes: tweetnacl.randomBytes,
        ...(variant === 'omitted-projection' ? {} : { sessionSpawnAdmission: variant === 'omitted-setup-fact'
          ? withoutSetup : { ...facts, machineSetupRequested: true } }),
      });
      const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-admitted-root', binding: {
        ...binding, principalId: principal.principalId, custodianAccountId: 'custodian', installationId: 'installation',
        machineId: target.machineId, grant: principal.grant, admittedMachineRole: 'manage', accountEncryptionMode: 'e2ee',
        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
      } });
      const spawnEffect = vi.fn(async () => SESSION_SPAWN_PENDING_RESULT);
      const result = await executeExternalAction({ actionId: binding.actionId, envelope, principal: spawnPrincipal,
        currentMachineId: target.machineId, currentInstallationId: 'installation', currentServerId: 'home-profile',
        executionAuthorization: authorization,
        externalActionMachineRequestPrivateKey: tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7)).secretKey,
        // Home signature verification and the installed OS launch are the boundaries.
        verifyExecutionAuthorization: async () => true,
        resolveEncryption: async () => ({ serverIdentityId: binding.serverIdentityId, material }),
        resolveTarget: createDaemonExternalActionTargetResolver({ credentials: { token: 'fixture', encryption: null } }),
        executor: createActionExecutor({ ...createUnavailableHostActionDeps(), sessionSpawnNew: spawnEffect }),
      });
      expect(result).toMatchObject({ kind: 'invalid_request', errorCode: 'invalid_encrypted_envelope' });
      expect(spawnEffect).not.toHaveBeenCalled();
    });

  it.each(['plain', 'e2ee'] as const)('admits exact %s Domain envelopes without requiring deploy candidate publication', async mode => {
    const target = { kind: 'machine' as const, machineId: 'domain-controller' };
    const accountPrincipal = { accountId: principal.accountId,
      authentication: { kind: 'account' as const, tokenEpoch: 0 }, authority: 'present_user' as const };
    const installation = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(52));
    const material = { type: 'dataKey' as const, machineKey: new Uint8Array(32).fill(53) };
    const diagnostics = vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => {});
    try {
      for (const actionId of ['deployments.domains.add', 'deployments.domains.remove', 'deployments.domains.verify'] as const) {
        const input = { serverId: 'domain-profile', environmentId: 'environment-a', domainId: 'domain-a',
          expectedRevision: 4, expectedDomainRevision: 1, requestKey: crypto.randomUUID(),
          ...(actionId === 'deployments.domains.add' ? { targetLinkId: 'runtime', expectedTargetLinkRevision: 1,
            contentArtifactId: 'private-domain', contentHeaderVersion: 1, contentBodyVersion: 1 } : {}) };
        const binding = { serverIdentityId: 'srv_domain_home', accountId: accountPrincipal.accountId,
          authentication: accountPrincipal.authentication, actionId, requestId: crypto.randomUUID(), target };
        const envelope = mode === 'e2ee'
          ? sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding, input, material, randomBytes: tweetnacl.randomBytes })
          : { v: 1 as const, requestId: binding.requestId, target, input };
        const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-domain-proof', binding: {
          ...binding, machineId: target.machineId, custodianAccountId: accountPrincipal.accountId,
          installationId: 'domain-installation', accountEncryptionMode: mode, environmentId: input.environmentId,
          deploymentChildRoot: isDeploymentChildRootActionIdV1(actionId),
          deploymentNativeAdmission: projectDeploymentNativeAdmissionV1(actionId, input),
          requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
        } });
        const run = (request: unknown = envelope) => executeExternalAction({ actionId, envelope: request,
          principal: accountPrincipal, executionAuthorization: authorization,
          currentMachineId: target.machineId, currentServerId: input.serverId, currentInstallationId: 'domain-installation',
          externalActionMachineRequestPrivateKey: installation.secretKey, verifyExecutionAuthorization: async () => true,
          resolveEncryption: async () => ({ serverIdentityId: binding.serverIdentityId, material }),
          resolveTarget: createDaemonExternalActionTargetResolver({ credentials: { token: 'fixture', encryption: null } }),
          executor: createActionExecutor(createUnavailableHostActionDeps()),
        });
        const result = await run();
        // The real Action policy may refuse unavailable native dependencies; envelope admission must succeed first.
        expect.soft(result).toMatchObject({ kind: 'response' });
        if (result.kind === 'response' && envelope.v === 2) {
          expect(openExternalActionResponseV2({ envelope: result.response, binding, material, request: envelope }))
            .not.toBeNull();
          expect.soft(await run({ ...envelope, payload: { t: 'plain', v: input } }))
            .toMatchObject({ kind: 'invalid_request', errorCode: 'invalid_envelope' });
        }
      }
    } finally { diagnostics.mockRestore(); }
  });

  it.each(['plain', 'e2ee'] as const)('delivers admitted requester theme content without changing ordinary registry reads (%s)', async mode => {
    const actionId = 'registries.items.read' as const;
    const target = { kind: 'machine' as const, machineId: 'theme-machine' };
    const accountPrincipal = { accountId: principal.accountId,
      authentication: { kind: 'account' as const, tokenEpoch: 0 }, authority: 'present_user' as const };
    const material = { type: 'dataKey' as const, machineKey: new Uint8Array(32).fill(53) };
    const installation = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(52));
    const source: RegistrySourceDescriptorV1 = { id: deriveMarketplaceSourceId('https://themes.example.test/index.json'), title: 'Private themes',
      url: 'https://themes.example.test/index.json', format: 'happier-catalog', kinds: ['theme'], enabled: true,
      addedAt: 0, origin: { kind: 'user' }, removable: true };
    const host = createRegistryHostV1({ host: 'node', readSources: async () => [source], http: {
      async getJson(url) { return { ok: true, fetchedAt: 1, value: url === source.url ? {
        source: { id: source.id, title: source.title, sourceUrl: source.url, kind: 'user' },
        freshness: { state: 'fresh', fetchedAtMs: 1 }, entries: [], picks: [], diagnostics: [], themes: [{
          itemId: 'night', title: 'Night', version: '1.0.0', listing: { includes: [{ key: 'night', label: 'Night', mode: 'dark' }] },
          contentUrl: 'https://themes.example.test/night.json',
        }],
      } : { themes: [{ key: 'night', label: 'Night', mode: 'dark', document: { schemaVersion: 1, id: 'night', name: 'Night',
        createdAt: '2026-11-16', updatedAt: '2026-11-16', base: { light: 'light', dark: 'dark' }, overrides: { light: {}, dark: {} } } }] } }; },
      async getText() { throw new Error('Unexpected text boundary'); }, async getBytes() { throw new Error('Unexpected package boundary'); },
    } });
    const realExecutor = createActionExecutor({ ...createUnavailableHostActionDeps(), registryActionExecute: ({ actionId, input, context }) =>
      host.execute(actionId, input, context.registryThemeContent ? { themeContent: context.registryThemeContent } : undefined) });
    for (const themeContent of [false, true]) {
      const input = { kind: 'theme', sourceId: source.id, itemId: 'night' };
      const binding = { serverIdentityId: 'srv_theme_home', accountId: accountPrincipal.accountId,
        authentication: accountPrincipal.authentication, actionId, requestId: crypto.randomUUID(), target };
      const intent = themeContent ? { registryThemeContent: true as const } : {};
      const envelope = mode === 'e2ee'
        ? sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1,
          binding, input, material, randomBytes: tweetnacl.randomBytes, ...intent })
        : { v: 1 as const, requestId: binding.requestId, target, input, ...intent };
      const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-theme-proof', binding: {
        ...binding, machineId: target.machineId, custodianAccountId: accountPrincipal.accountId,
        installationId: 'theme-installation', accountEncryptionMode: mode,
        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
      } });
      const result = await executeExternalAction({ actionId, envelope, principal: accountPrincipal, executionAuthorization: authorization,
        currentMachineId: target.machineId, currentServerId: 'theme-home', currentInstallationId: 'theme-installation',
        externalActionMachineRequestPrivateKey: installation.secretKey, verifyExecutionAuthorization: async () => true,
        resolveEncryption: async () => ({ serverIdentityId: binding.serverIdentityId, material }),
        resolveTarget: createDaemonExternalActionTargetResolver({ credentials: { token: 'fixture', encryption: null } }), executor: realExecutor });
      expect(result.kind).toBe('response');
      if (result.kind !== 'response') continue;
      const execution = envelope.v === 2 ? openExternalActionResponseV2({ envelope: result.response, binding, material, request: envelope })
        : result.response.v === 1 ? result.response.execution : null;
      expect(execution, JSON.stringify(execution)).toMatchObject({ ok: true, result: { item: { payload: {
        kind: 'theme', state: themeContent ? 'ready' : 'listing',
        ...(themeContent ? { themes: [{ document: { profile: { assetAppearance: 'dark' } } }] } : {}),
      } } } });
    }
  });

  it.each(['plain', 'e2ee'] as const)('refuses unsupported protected logs operands before ordinary Action IO (%s, waived positive control)', async mode => {
    const actionId = 'machines.services.logs.read' as const;
    const target = { kind: 'machine' as const, machineId: 'logs-constraint-machine' };
    const input = { serverId: 'logs-home', machineId: target.machineId, serviceId: 'worker' };
    const installation = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(44));
    const material = { type: 'dataKey' as const, machineKey: new Uint8Array(32).fill(45) };
    const accountPrincipal = { accountId: principal.accountId,
      authentication: { kind: 'account' as const, tokenEpoch: 0 }, authority: 'present_user' as const };
    let nativeReads = 0;
    const network = vi.spyOn(axios, 'get').mockRejectedValue(new Error('Unsupported continuation must not enter ordinary target IO'));
    // Installed key material, Home authorization verification and native IO are
    // system boundaries. Envelope crypto, target resolution and Actions stay real.
    const page = { kind: 'page' as const, page: { sourceRevision: 'current-source', text: 'current native bytes', nextCursor: null, truncated: false } };
    const actionsSettings = ActionsSettingsV1Schema.parse({ v: 1, scopedApprovalPreferences: [{ actionId,
      scope: { kind: 'machine', machineId: target.machineId }, approvalRequiredSurfaces: [], approvalWaivedSurfaces: ['ui'] }] });
    const realExecutor = createActionExecutor({ ...createUnavailableHostActionDeps(),
      machineServiceLogsRead: async () => { nativeReads++; return page; },
    });
    // Account settings are input to the real policy owner, not an approval result.
    const executor: ExternalActionExecutor = { execute: (id, value, context) => realExecutor.execute(id, value, { ...context, actionsSettings }) };
    const invoke = async (requestId: string,
      protectedInput: Pick<Parameters<typeof sealExternalActionRequestV2>[0], 'resourceContinuation' | 'machineServiceLogsGeneration'> = {}) => {
      const binding = { serverIdentityId: 'srv_logs_home', accountId: accountPrincipal.accountId,
        authentication: accountPrincipal.authentication, actionId, requestId, target };
      const envelope = mode === 'e2ee'
        ? sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding, material, input, ...protectedInput,
          randomBytes: length => new Uint8Array(length).fill(46) })
        : { v: 1 as const, requestId: binding.requestId, target, input, ...protectedInput };
      const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-logs-proof', binding: {
        ...binding, machineId: target.machineId, custodianAccountId: accountPrincipal.accountId,
        installationId: 'logs-installation', accountEncryptionMode: mode,
        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
      } });
      const result = await executeExternalAction({ actionId, envelope, principal: accountPrincipal, executionAuthorization: authorization,
        currentMachineId: target.machineId, currentServerId: input.serverId, currentInstallationId: 'logs-installation',
        externalActionMachineRequestPrivateKey: installation.secretKey, verifyExecutionAuthorization: async () => true,
        resolveEncryption: async () => ({ serverIdentityId: binding.serverIdentityId, material }),
        resolveTarget: createDaemonExternalActionTargetResolver({ credentials: { token: 'fixture', encryption: null } }), executor,
      });
      const execution = result.kind !== 'response' ? null : envelope.v === 2
        ? openExternalActionResponseV2({ envelope: result.response, binding, material, request: envelope })
        : result.response.v === 1 ? result.response.execution : null;
      return { result, execution };
    };
    try {
      expect(await invoke(`ordinary-${mode}`)).toMatchObject({ result: { kind: 'response' }, execution: { ok: true, result: page } });
      expect(nativeReads).toBe(1);
      for (const operand of ['generation', 'resource'] as const) {
        const protectedInput: Pick<Parameters<typeof sealExternalActionRequestV2>[0], 'resourceContinuation' | 'machineServiceLogsGeneration'> = operand === 'generation'
          ? { machineServiceLogsGeneration: { expectedGeneration: 'retired-generation' } }
          : { resourceContinuation: { method: RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_READ, params: {
            machineId: target.machineId, resource: { hostRead: 'machines.services.logs' as const, input,
              expectedGeneration: 'retired-generation', sourceRevision: 'retired-source' },
          } } };
        expect.soft(await invoke(`unsupported-${mode}-${operand}`, protectedInput))
          .toMatchObject({ result: { kind: 'invalid_request', errorCode: mode === 'e2ee' ? 'invalid_encrypted_envelope' : 'invalid_envelope' } });
      }

      expect(nativeReads).toBe(1);
      expect(network).not.toHaveBeenCalled();
    } finally { network.mockRestore(); }
  });

  it.each([
    ['registries.updates.check', { kind: 'app', environments: [{ environmentId: 'selected', expectedRevision: 1 }] }],
    ['deployments.health.read', { serverId: 'srv_registry', environmentId: 'selected', deploymentId: 'receipt',
      targetLinkId: 'runtime', machineId: 'registry-machine', installationId: 'installation',
      service: { kind: 'deployment', machineId: 'registry-machine', environmentId: 'selected',
        environmentInstanceId: 'instance', composeService: 'web', serviceId: 'instance/web' } }],
  ] as const)('admits local %s before signed remote admission exists', async (actionId, input) => {
    const result = await executeExternalAction({
      actionId,
      envelope: { v: 1, requestId: 'local-app-update', input },
      principal: { authority: 'account_automation' },
      localRootInvocation: { caller: { kind: 'host' }, surface: 'cli', authority: 'account_automation' },
      currentMachineId: 'registry-machine', currentAccountId: 'account-1', currentServerId: 'srv_registry',
      resolveTarget: createDaemonExternalActionTargetResolver({ credentials: { token: 'fixture', encryption: null } }),
      executor: createActionExecutor(createUnavailableHostActionDeps()),
    });
    // The intentionally unavailable host must produce an executor result, not
    // reject the local input as an invalid signed remote envelope.
    expect(result).toMatchObject({ kind: 'response', response: { execution: { ok: false } } });
  });

  it('refuses missing or substituted app update demand before any Account or registry read', async () => {
    const actionId = 'registries.updates.check';
    const installation = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(43));
    const target = { kind: 'machine' as const, machineId: 'registry-machine' };
    const input = { kind: 'app', environments: [{ environmentId: 'selected', expectedRevision: 1 }] };
    const envelope = { v: 1 as const, requestId: 'app-update-request', input, target };
    const network = vi.spyOn(axios, 'get').mockRejectedValue(new Error('Mismatched app demand must not open Account content'));
    for (const demand of [undefined, { environments: [{ environmentId: 'another', expectedRevision: 1 }] }]) {
      const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-proof', binding: {
        accountId: principal.accountId, principalId: principal.principalId, credentialId: principal.credentialId, grant: principal.grant,
        serverIdentityId: 'srv_registry', machineId: target.machineId, custodianAccountId: principal.accountId,
        installationId: 'installation', actionId, requestId: envelope.requestId, target,
        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
        ...(demand ? { registryAppUpdateAdmission: demand } : {}),
      } });
      expect(await executeExternalAction({ actionId, envelope, principal, executionAuthorization: authorization,
        currentMachineId: target.machineId, currentServerId: 'srv_registry', currentInstallationId: 'installation',
        externalActionMachineRequestPrivateKey: installation.secretKey, verifyExecutionAuthorization: async () => true,
        resolveTarget: createDaemonExternalActionTargetResolver({ credentials: { token: 'fixture', encryption: null } }),
        executor: createActionExecutor(createUnavailableHostActionDeps()),
      })).toMatchObject({ kind: 'invalid_request', errorCode: 'invalid_envelope' });
    }
    expect(network).not.toHaveBeenCalled();
  });

  it('refuses signed Prepare reference or Home substitution before workspace or native access', async () => {
    const actionId = 'deployments.prepare';
    const installation = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(42));
    const target = { kind: 'machine' as const, machineId: 'prepare-machine' };
    const prepareInput = { projectSourceId: 'source', sourceRevision: 1,
      workspace: { kind: 'workspace-ref', serverId: 'srv_prepare', id: 'workspace' },
      sessionRef: { serverId: 'srv_prepare', sessionId: 'preparation-session' },
      repository: { kind: 'github', deployment: 'https://github.com', repository: 'private/project' }, baseCommit: 'a'.repeat(40) };
    const network = vi.spyOn(axios, 'get').mockRejectedValue(new Error('A substituted preparation must not open content'));
    for (const variant of ['purpose', 'home'] as const) {
      const input = variant === 'home' ? { ...prepareInput, workspace: { ...prepareInput.workspace, serverId: 'foreign' } } : prepareInput;
      const envelope = { v: 1 as const, requestId: 'prepare-request', input, target };
      const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-proof', binding: {
        accountId: principal.accountId, principalId: principal.principalId, credentialId: principal.credentialId, grant: principal.grant,
        serverIdentityId: 'srv_prepare', machineId: target.machineId, custodianAccountId: principal.accountId,
        installationId: 'installation', actionId, requestId: envelope.requestId, target,
        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
        deploymentPreparationAdmission: { operation: 'prepare', source: { id: 'source', revision: 1 },
          workspace: { kind: 'workspace-ref', id: variant === 'purpose' ? 'another' : 'workspace' } },
      } });
      expect(await executeExternalAction({ actionId, envelope, principal, executionAuthorization: authorization,
        currentMachineId: target.machineId, currentServerId: 'srv_prepare', currentInstallationId: 'installation',
        externalActionMachineRequestPrivateKey: installation.secretKey,
        verifyExecutionAuthorization: async () => true,
        resolveTarget: createDaemonExternalActionTargetResolver({ credentials: { token: 'fixture', encryption: null } }),
        executor: createActionExecutor(createUnavailableHostActionDeps()),
      })).toMatchObject({ kind: 'invalid_request', errorCode: 'invalid_envelope' });
    }
    expect(network).not.toHaveBeenCalled();
    const envelope = { v: 1 as const, requestId: 'matching-prepare-request', input: prepareInput, target };
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-proof', binding: {
      accountId: principal.accountId, principalId: principal.principalId, credentialId: principal.credentialId, grant: principal.grant,
      serverIdentityId: 'srv_prepare', machineId: target.machineId, custodianAccountId: principal.accountId,
      installationId: 'installation', actionId, requestId: envelope.requestId, target,
      requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
      deploymentPreparationAdmission: { operation: 'prepare', source: { id: 'source', revision: 1 },
        workspace: { kind: 'workspace-ref', id: 'workspace' } },
    } });
    expect(await executeExternalAction({ actionId, envelope, principal, executionAuthorization: authorization,
      currentMachineId: target.machineId, currentServerId: 'srv_prepare', currentInstallationId: 'installation',
      externalActionMachineRequestPrivateKey: installation.secretKey,
      verifyExecutionAuthorization: async () => true,
      resolveTarget: createDaemonExternalActionTargetResolver({ credentials: { token: 'fixture', encryption: null } }),
      executor: createActionExecutor(createUnavailableHostActionDeps()),
    })).toMatchObject({ kind: 'response' });
  });
  it.each(['deployments.environments.create', 'deployments.publish.prepare', 'machines.reboot'] as const)(
    'opens the root Home of encrypted deployment preparation without accepting a foreign Home (%s)', async actionId => {
      const material = { type: 'dataKey' as const, machineKey: new Uint8Array(32).fill(47) };
      const installation = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(48));
      const target = { kind: 'machine' as const, machineId: 'preparation-machine' };
      const requestPrincipal = { ...principal, credentialId: '00000000-0000-4000-8000-000000000001' };
      const publicInput = actionId === 'deployments.environments.create'
        ? { serverId: 'srv_preparation', projectSourceId: 'source', requestKey: 'copy-request', name: 'Duplicate',
          protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
          copyFrom: { environmentId: 'original', expectedRevision: 2, choices: { secrets: [], values: [], data: [] } } }
        : actionId === 'deployments.publish.prepare'
          ? { serverId: 'srv_preparation', projectSourceId: 'source', sourceRevision: 2,
            machineId: target.machineId, installationId: 'preparation-installation',
            templateRef: { sourceId: 'catalog', itemId: 'app', version: '1', ref: { kind: 'version', version: '1' } } }
          // Reboot spends the setup preparation family but names its Home as serverId.
          : { serverId: 'srv_preparation', machineId: target.machineId, expectedInstallationId: 'preparation-installation' };
      for (const home of ['srv_preparation', 'foreign'] as const) {
        const input = getActionSpec(actionId).inputSchema.parse({ ...publicInput, serverId: home });
        const binding = { serverIdentityId: 'srv_preparation', accountId: principal.accountId,
          credentialId: requestPrincipal.credentialId, actionId, requestId: `${actionId}-${home}`, target };
        const envelope = sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding, material, input, randomBytes: tweetnacl.randomBytes });
        expect(envelope.deploymentPreparationAdmission?.operation).toBe(actionId === 'deployments.environments.create' ? 'create'
          : actionId === 'machines.reboot' ? 'setup' : 'catalog');
        const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-proof', binding: {
          ...binding, principalId: principal.principalId, grant: principal.grant,
          custodianAccountId: principal.accountId, machineId: target.machineId, installationId: 'preparation-installation',
          accountEncryptionMode: 'e2ee', requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
          deploymentPreparationAdmission: envelope.deploymentPreparationAdmission,
        } });
        // Home verification and installed encryption material are system boundaries;
        // the public input, real V2 codec, admission, target resolver and Action executor are not replaced.
        const result = await executeExternalAction({ actionId, envelope, principal: requestPrincipal, executionAuthorization: authorization,
          currentMachineId: target.machineId, currentServerId: binding.serverIdentityId,
          currentInstallationId: 'preparation-installation', externalActionMachineRequestPrivateKey: installation.secretKey,
          verifyExecutionAuthorization: async () => true,
          resolveEncryption: async () => ({ serverIdentityId: binding.serverIdentityId, material }),
          resolveTarget: createDaemonExternalActionTargetResolver({ credentials: { token: 'fixture', encryption: null } }),
          executor: createActionExecutor(createUnavailableHostActionDeps()),
        });
        if (home === 'foreign') {
          expect(result).toMatchObject({ kind: 'invalid_request', errorCode: 'invalid_encrypted_envelope' });
        } else {
          expect(result, JSON.stringify(result)).toMatchObject({ kind: 'response', response: { v: 2 } });
          if (result.kind !== 'response') throw new Error('Matching preparation Home was refused before Action admission');
          expect(openExternalActionResponseV2({ envelope: result.response, binding, request: envelope, material }))
            .toMatchObject({ ok: false });
        }
      }
    });
  it.each(['plain', 'e2ee'] as const)('binds signed backup operands to the opened %s invocation before native access', async mode => {
    const actionId = 'deployments.backups.verify';
    const requestPrincipal = { accountId: principal.accountId, authentication: { kind: 'account', tokenEpoch: 1 },
      authority: 'account_automation' } as const;
    const material = { type: 'dataKey' as const, machineKey: new Uint8Array(32).fill(52) };
    const installation = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(53));
    const target = { kind: 'machine' as const, machineId: 'backup-machine' };
    const admittedInput = getActionSpec(actionId).inputSchema.parse({ serverId: 'srv_backup', environmentId: 'environment',
      deploymentId: 'receipt', targetLinkId: 'runtime', machineId: target.machineId, installationId: 'installation',
      expectedRevision: 1, configRevision: 1, backupOperationId: 'capture', snapshotId: 'a'.repeat(64), level: 'manifestReadBack' });
    for (const level of ['repositoryCheck', 'manifestReadBack'] as const) {
      const input = { ...admittedInput, level };
      const binding = { serverIdentityId: 'srv_backup', accountId: principal.accountId, authentication: requestPrincipal.authentication,
        actionId, requestId: `backup-${mode}-${level}`, target };
      const envelope = mode === 'e2ee' ? sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding, material, input, randomBytes: tweetnacl.randomBytes })
        : { v: 1 as const, requestId: binding.requestId, target, input };
      const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-proof', binding: {
        ...binding, custodianAccountId: principal.accountId,
        machineId: target.machineId, installationId: 'installation', accountEncryptionMode: mode,
        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
        environmentId: admittedInput.environmentId, deploymentNativeAdmission: projectDeploymentNativeAdmissionV1(actionId, admittedInput),
      } });
      // Home verification and installed encryption material are transport boundaries;
      // decoding, admission projection, target resolution and Action admission remain real.
      const result = await executeExternalAction({ actionId, envelope, principal: requestPrincipal, executionAuthorization: authorization,
        currentMachineId: target.machineId, currentServerId: binding.serverIdentityId, currentInstallationId: 'installation',
        externalActionMachineRequestPrivateKey: installation.secretKey, verifyExecutionAuthorization: async () => true,
        resolveEncryption: async () => ({ serverIdentityId: binding.serverIdentityId, material }),
        resolveTarget: createDaemonExternalActionTargetResolver({ credentials: { token: 'fixture', encryption: null } }),
        executor: createActionExecutor(createUnavailableHostActionDeps()),
      });
      expect(result).toMatchObject(level === 'manifestReadBack' ? { kind: 'response' }
        : { kind: 'invalid_request', errorCode: mode === 'e2ee' ? 'invalid_encrypted_envelope' : 'invalid_envelope' });
    }
  });
  it('refuses a signed deployment read whose opened purpose or Home differs before target or native access', async () => {
    const actionId = 'deployments.health.read';
    const installation = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(41));
    const target = { kind: 'machine' as const, machineId: 'read-machine' };
    const readInput = { serverId: 'srv_read', environmentId: 'environment', deploymentId: 'receipt', targetLinkId: 'runtime',
      machineId: target.machineId, installationId: 'installation', service: { kind: 'deployment', machineId: target.machineId,
        environmentId: 'environment', environmentInstanceId: 'instance', composeService: 'web', serviceId: 'instance/web' } };
    const credentials = { token: 'fixture', encryption: null };
    const network = vi.spyOn(axios, 'get').mockRejectedValue(new Error('A mismatched read must not reach content transport'));
    for (const variant of ['purpose', 'home'] as const) {
      const input = variant === 'home' ? { ...readInput, serverId: 'foreign' } : readInput;
      const envelope = { v: 1 as const, requestId: 'read-request', input, target };
      const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-proof', binding: {
        accountId: principal.accountId, principalId: principal.principalId, credentialId: principal.credentialId,
        grant: principal.grant,
        serverIdentityId: 'srv_read', machineId: target.machineId, custodianAccountId: principal.accountId,
        installationId: 'installation', actionId, requestId: envelope.requestId, target,
        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
        deploymentReadAdmission: { actionId, environmentId: 'environment', deploymentId: variant === 'purpose' ? 'another' : 'receipt',
          targetLinkId: 'runtime', machineId: target.machineId, installationId: 'installation' },
      } });
      const result = await executeExternalAction({ actionId, envelope, principal, executionAuthorization: authorization,
        currentMachineId: target.machineId, currentServerId: 'srv_read', currentInstallationId: 'installation',
        externalActionMachineRequestPrivateKey: installation.secretKey,
        verifyExecutionAuthorization: async () => true,
        resolveTarget: createDaemonExternalActionTargetResolver({ credentials }),
        executor: createActionExecutor(createUnavailableHostActionDeps()),
      });
      expect(result).toMatchObject({ kind: 'invalid_request', errorCode: 'invalid_envelope' });
    }
    expect(network).not.toHaveBeenCalled();
    const envelope = { v: 1 as const, requestId: 'matching-read-request', input: readInput, target };
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-proof', binding: {
      accountId: principal.accountId, principalId: principal.principalId, credentialId: principal.credentialId,
      grant: principal.grant, serverIdentityId: 'srv_read', machineId: target.machineId, custodianAccountId: principal.accountId,
      installationId: 'installation', actionId, requestId: envelope.requestId, target,
      requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
      deploymentReadAdmission: { actionId, environmentId: 'environment', deploymentId: 'receipt',
        targetLinkId: 'runtime', machineId: target.machineId, installationId: 'installation' },
    } });
    expect(await executeExternalAction({ actionId, envelope, principal, executionAuthorization: authorization,
      currentMachineId: target.machineId, currentServerId: 'srv_read', currentInstallationId: 'installation',
      externalActionMachineRequestPrivateKey: installation.secretKey,
      verifyExecutionAuthorization: async () => true,
      resolveTarget: createDaemonExternalActionTargetResolver({ credentials }),
      executor: createActionExecutor(createUnavailableHostActionDeps()),
    })).toMatchObject({ kind: 'response', response: { execution: { ok: false, errorCode: 'deployment_unavailable' } } });
  });
  it.each([
    { kind: 'account', settingsFailure: false, rootFailure: false, rootUnavailable: false },
    { kind: 'terminal', settingsFailure: false, rootFailure: false, rootUnavailable: false },
    { kind: 'account', settingsFailure: true, rootFailure: false, rootUnavailable: false },
    { kind: 'account', settingsFailure: false, rootFailure: true, rootUnavailable: false },
    { kind: 'account', settingsFailure: false, rootFailure: false, rootUnavailable: true },
    { kind: 'account', settingsFailure: false, rootFailure: false, rootUnavailable: false, profileFailure: 'schema' },
    { kind: 'account', settingsFailure: false, rootFailure: false, rootUnavailable: false, profileFailure: 'upgrade' },
  ] as const)('opens an own-Account E2EE Browser request through installed custody (%s)', async scenario => {
    const { kind, settingsFailure, rootFailure, rootUnavailable } = scenario;
    const profileFailure = 'profileFailure' in scenario ? scenario.profileFailure : undefined;
    const phaseLog = vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => {});
    const accountId = 'browser-own-account';
    const material = { type: 'dataKey' as const, machineKey: new Uint8Array(32).fill(19) };
    const credentials = { token: 'installed-browser-custody', encryption: { ...material,
      publicKey: tweetnacl.box.keyPair.fromSecretKey(material.machineKey).publicKey } };
    const installation = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(21));
    const target = { kind: 'machine' as const, machineId: 'browser-machine' };
    const actionId = 'browser.diagnostics.snapshot';
    const authentication = { kind, tokenEpoch: 3 };
    const binding = { serverIdentityId: 'srv_browser', accountId, authentication, actionId,
      requestId: `browser-own-${kind}`, target };
    const envelope = sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding, material, randomBytes: tweetnacl.randomBytes,
      input: { browserSessionId: 'browser-session', viewId: 'browser-view' } });
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'browser-home-root', binding: { ...binding,
      custodianAccountId: accountId, machineId: target.machineId, installationId: 'browser-installation',
      accountEncryptionMode: 'e2ee', requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) } });
    const settings = prepareAccountSettingsV2Content({ credentials, raw: {}, envelopeKind: 'encrypted' });
    const get = vi.spyOn(axios, 'get').mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/profile') return profileFailure === 'upgrade'
        ? { status: 426, data: AccountStoredContentUpgradeRequiredV1Schema.parse({ error: 'client-upgrade-required',
          requirement: { v: 1, kind: 'account-stored-content', minimumProtocolVersion: 1 } }) }
        : { status: 200, data: { id: profileFailure === 'schema' ? null : accountId } };
      if (path === '/v2/account/settings') {
        if (settingsFailure) throw new TypeError('private-account-content must not enter diagnostics');
        return { status: 200, data: { content: settings, version: 1 } };
      }
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'e2ee', version: 1,
        signingKeyFingerprint: null, contentKeyFingerprint: computeAccountEncryptionMigrateKeyFingerprintV1(credentials.encryption.publicKey), updatedAt: 1 } };
      throw new Error('Unexpected Browser Account read');
    });
    const post = vi.spyOn(axios, 'post').mockImplementation(async () => {
      if (rootUnavailable) return { status: 503, data: { error: 'database_connection_unavailable' } };
      if (rootFailure) {
        const error = new TypeError('private-account-content.Schema.nullable is not a function');
        error.name = 'private-account-content';
        throw error;
      }
      return { status: 200, data: { ok: true } };
    });
    try {
      const executor = createActionExecutor(createUnavailableHostActionDeps());
      const result = await executeExternalAction({ actionId, envelope, principal: { accountId, authentication,
        authority: kind === 'account' ? 'present_user' : 'account_automation' }, executionAuthorization: authorization,
        currentMachineId: target.machineId, currentServerId: 'browser-profile', currentInstallationId: 'browser-installation',
        externalActionMachineRequestPrivateKey: installation.secretKey, verifyExecutionAuthorization: async () => true,
        resolveTarget: createDaemonExternalActionTargetResolver({ credentials }), executor,
        prepareRequesterAccountContext: request => prepareRequesterAccountActionContext({ authorization: request.authorization,
          purpose: { kind: 'external_action' }, machineId: target.machineId, installationId: 'browser-installation',
          installationPrivateKey: installation.secretKey, serverId: 'browser-profile', serverIdentityId: binding.serverIdentityId,
          serverHttpBaseUrl: 'https://browser-home.test', ownCredentials: credentials, isCurrent: async () => true,
          createExecutor: () => executor }),
      });
      const diagnostics = JSON.stringify(phaseLog.mock.calls);
      expect(diagnostics).not.toContain('private-account-content');
      expect(diagnostics).not.toContain(accountId);
      expect(diagnostics).not.toContain(credentials.token);
      expect(diagnostics).not.toContain(envelope.payload.c);
      if (profileFailure) {
        expect(result).toMatchObject({ kind: 'invalid_request', errorCode: 'internal_error', requestId: binding.requestId,
          failureCause: { phase: 'requester.profile', errorClass: profileFailure === 'schema' ? '$ZodError' : 'HttpStatusError',
            errorCode: profileFailure === 'schema' ? null : 'client-upgrade-required',
            httpStatus: profileFailure === 'schema' ? null : 426 } });
        if (result.kind !== 'invalid_request' || !('failureCause' in result)) throw new Error('expected_profile_refusal');
        expect(parseExternalActionDaemonDispatchResult(result)).toEqual(result);
        const httpFailure = projectExternalActionHttpError(result.errorCode, result.requestId,
          undefined, undefined, undefined, undefined, result.failureCause);
        expect(ExternalActionHttpErrorSchema.parse(httpFailure.payload)).toMatchObject({ error: 'invalid_request',
          code: 'internal_error', failureCause: result.failureCause });
        expect(JSON.stringify(result)).not.toContain('private-');
        return;
      }
      if (rootUnavailable) {
        expect(result).toEqual({ kind: 'invalid_request', errorCode: 'project_requester_home_unavailable', requestId: binding.requestId });
        if (result.kind !== 'invalid_request') throw new Error('expected_pre_open_refusal');
        expect(parseExternalActionDaemonDispatchResult(result)).toEqual(result);
        const httpFailure = projectExternalActionHttpError(result.errorCode, result.requestId);
        expect(httpFailure.statusCode).toBe(503);
        expect(classifyServerEndpointError({ response: { status: httpFailure.statusCode } }).retryable).toBe(true);
        expect(ExternalActionHttpErrorSchema.parse(httpFailure.payload)).toEqual({ error: 'invalid_request',
          code: 'project_requester_home_unavailable', requestId: binding.requestId });
        return;
      }
      if (settingsFailure || rootFailure) {
        expect(result).toEqual({ kind: 'invalid_request', errorCode: 'invalid_encrypted_envelope', requestId: binding.requestId });
        expect(phaseLog).toHaveBeenCalledWith('[external-action-phase]', expect.objectContaining({
          machineId: target.machineId, phase: settingsFailure ? 'requester_settings' : 'signed_root_http_request',
          ...(rootFailure ? { errorClass: 'TypeError', message: 'Schema .nullable is not a function' } : {}),
        }));
        return;
      }
      expect(result).toMatchObject({ kind: 'response', response: { v: 2 } });
      if (result.kind !== 'response') throw new Error('Browser request failed before Action dispatch');
      expect(openExternalActionResponseV2({ envelope: result.response, request: envelope, binding, material })).not.toBeNull();
    } finally { get.mockRestore(); post.mockRestore(); phaseLog.mockRestore(); }
  });
  it.each(['account', 'terminal'] as const)('binds fresh beginConnect custody to the sealed CLI %s decision authority', async kind => {
    const accountId = 'connect-requester';
    const token = `fixture.${Buffer.from(JSON.stringify({ sub: accountId, tokenEpoch: 7,
      ...(kind === 'terminal' ? { session: 'terminal-session', provenance: { v: 1, kind: 'terminal', authority: 'account_automation' } } : {}),
    })).toString('base64url')}.signature`;
    const material = { type: 'dataKey' as const, machineKey: new Uint8Array(32).fill(31) };
    const credentials = { token, encryption: { ...material, publicKey: tweetnacl.box.keyPair.fromSecretKey(material.machineKey).publicKey },
      credentialProvenance: 'stored_session' as const };
    const installation = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(22));
    const target = { kind: 'machine' as const, machineId: 'controller' };
    const actionId = 'approval.request.decide';
    const authentication = { kind, tokenEpoch: 7 };
    const binding = { serverIdentityId: 'srv_home', accountId, authentication, actionId,
      requestId: 'connect-decision', target };
    const envelope = sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1,
      binding, material, input: { artifactId: 'connect-approval', decision: 'approve' }, randomBytes: tweetnacl.randomBytes });
    const authorization = sealExternalActionRequesterAccountContextV1({ authorization: { v: 1, token: 'home-root', binding: {
      ...binding, accountEncryptionMode: 'e2ee', custodianAccountId: 'custodian', machineId: target.machineId,
      installationId: 'installation', requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
      approvalDecisionAdmission: envelope.approvalDecisionAdmission,
    } }, credentials: encodeStoredCredentials(credentials), purpose: { kind: 'external_action' },
      invocation: { caller: { kind: 'host' }, surface: 'cli', authority: 'present_user' },
      installationPublicKey: installation.publicKey, randomBytes: tweetnacl.randomBytes });
    const settings = prepareAccountSettingsV2Content({ credentials, raw: {}, envelopeKind: 'encrypted' });
    const service = { pluginId: 'example.accounts', localId: 'service' };
    const output = getActionSpec('connectedServices.authentication.beginConnect').outputSchema!.parse({
      status: 'configurationRequired', attemptId: 'attempt',
      target: { kind: 'attempt', attemptId: 'attempt', service, modeId: 'password' }, missingFieldIds: ['mailbox'],
    });
    let stored: ApprovalRequest | null = null;
    let effects = 0;
    const resolveTarget = createDaemonExternalActionTargetResolver({ credentials });
    const currentness = createDaemonApprovalExecutionOriginCurrentness({ accountId, machineId: target.machineId,
      serverId: 'profile', resolveTarget,
      resolveCurrentMachineExecutionOriginContext: async () => ({ machineId: target.machineId, serverIdentityId: 'srv_home' }),
      isAccountCurrent: async () => true, listAccountApiTokens: async () => ({ tokens: [] }),
    });
    // Artifact persistence and the native authentication command are system boundaries.
    const executor = createActionExecutor({ ...createUnavailableHostActionDeps(),
      approvalsCreate: async ({ request }) => { stored = ApprovalRequestV2Schema.parse(request); return { artifactId: 'connect-approval' }; },
      approvalsGet: async () => stored,
      approvalsUpdate: async ({ request }) => {
        if (!stored) throw new Error('Missing approval');
        const next = ApprovalRequestV2Schema.parse(request);
        const transition = decideApprovalRequestTransition(stored, next);
        if (!transition.ok) return transition;
        stored = next; return { ok: true };
      },
      isApprovalExecutionOriginCurrent: currentness,
      connectedServiceAction: async () => { effects++; return output; },
    });
    const created = await executor.execute('connectedServices.authentication.beginConnect', { machineId: target.machineId, service, modeId: 'password' },
      { surface: 'cli', authority: 'account_automation', actionCaller: { kind: 'host' }, runtimeAccountId: accountId,
        serverId: 'profile', serverIdentityId: 'srv_home', actionRequestId: 'connect-origin', defaultSessionMachineId: target.machineId,
        actionsSettings: ActionsSettingsV1Schema.parse({ v: 1, actions: {
          'connectedServices.authentication.beginConnect': { approvalRequiredSurfaces: ['cli'] },
        } }) });
    expect(created, created.ok ? undefined : created.errorCode).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
    expect(stored).toMatchObject({ approval: { flow: 'deferred' } });
    const get = vi.spyOn(axios, 'get').mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/profile') return { status: 200, data: { id: accountId } };
      if (path === '/v2/account/settings') return { status: 200, data: { content: settings, version: 1 } };
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'e2ee', version: 1,
        signingKeyFingerprint: null, contentKeyFingerprint: computeAccountEncryptionMigrateKeyFingerprintV1(credentials.encryption.publicKey), updatedAt: 1 } };
      throw new Error(`Unexpected requester GET ${path}`);
    });
    const post = vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { ok: true } });
    try {
      const run = () => executeExternalAction({ actionId, envelope,
        principal: { accountId, authentication, authority: 'account_automation' }, surface: 'cli', executionAuthorization: authorization,
        currentMachineId: target.machineId, currentServerId: 'profile', currentAccountId: 'custodian', currentInstallationId: 'installation',
        externalActionMachineRequestPrivateKey: installation.secretKey, verifyExecutionAuthorization: async () => true,
        resolveTarget: createDaemonExternalActionTargetResolver({ credentials: { token: 'custodian', encryption: null } }), executor,
        prepareRequesterAccountContext: request => prepareRequesterAccountActionContext({ authorization: request.authorization,
          purpose: { kind: 'external_action' }, machineId: target.machineId, installationId: 'installation',
          installationPrivateKey: installation.secretKey, serverId: 'profile', serverIdentityId: 'srv_home',
          serverHttpBaseUrl: 'https://home.test', isCurrent: async () => true, createExecutor: () => executor }),
      });
      const result = await run();
      expect(result).toMatchObject({ kind: 'response', response: { v: 2 } });
      if (result.kind !== 'response') throw new Error('Missing encrypted decision reply');
      const openedDecision = openExternalActionResponseV2({ envelope: result.response, request: envelope, binding, material });
      if (kind === 'terminal') {
        expect(openedDecision).toMatchObject({ ok: false, errorCode: 'present_user_required' });
        expect(stored).toMatchObject({ status: 'open' });
        expect(effects).toBe(0);
        return;
      }
      expect(openedDecision, JSON.stringify(openedDecision))
        .toMatchObject({ ok: true, result: { status: 'executed', liveExecution: { ok: true, result: output } } });
      const repeated = await run();
      if (repeated.kind !== 'response') throw new Error('Missing repeated reply');
      const receipt = openExternalActionResponseV2({ envelope: repeated.response, request: envelope, binding, material });
      expect(receipt).toMatchObject({ ok: true, result: { status: 'executed' } });
      if (receipt?.ok) expect(receipt.result).not.toHaveProperty('liveExecution');
      expect(effects).toBe(1);
      expect(ApprovalRequestV2Schema.parse(stored).execution?.result).not.toHaveProperty('target');
    } finally { get.mockRestore(); post.mockRestore(); }
  });
  it.each([null, 'credential_scope_denied', 'invalid_token'] as const)('preserves terminal E2EE identity and reports verify authorization refusal (refused: %s)', async refused => {
    const accountId = 'bob-terminal';
    const token = `fixture.${Buffer.from(JSON.stringify({ sub: accountId, session: 'bob-terminal-session', tokenEpoch: 7,
      provenance: { v: 1, kind: 'terminal', authority: 'account_automation' } })).toString('base64url')}.signature`;
    const material = { type: 'dataKey' as const, machineKey: new Uint8Array(32).fill(31) };
    const credentials = { token, encryption: { ...material, publicKey: tweetnacl.box.keyPair.fromSecretKey(material.machineKey).publicKey },
      credentialProvenance: 'stored_session' as const };
    const installation = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(22));
    const target = { kind: 'machine' as const, machineId: 'alice-controller' };
    const actionId = 'machines.managed.list';
    const authentication = { kind: 'terminal' as const, tokenEpoch: 7 };
    const principal = { accountId, authority: 'account_automation' as const, authentication };
    const binding = { serverIdentityId: 'srv_home', accountId, authentication, actionId,
      requestId: 'terminal-e2ee-request', target };
    const envelope = sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding, material, input: { homeId: 'srv_home' }, randomBytes: tweetnacl.randomBytes });
    const authorization = sealExternalActionRequesterAccountContextV1({ authorization: { v: 1, token: 'home-terminal-root', binding: {
      ...binding, accountEncryptionMode: 'e2ee', custodianAccountId: 'alice', machineId: target.machineId,
      installationId: 'alice-installation', requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
    } }, credentials: encodeStoredCredentials(credentials), purpose: { kind: 'external_action' },
      installationPublicKey: installation.publicKey, randomBytes: tweetnacl.randomBytes });
    const settings = prepareAccountSettingsV2Content({ credentials, raw: {}, envelopeKind: 'encrypted' });
    let effects = 0;
    let servedContext: ActionExecutorContext | undefined;
    const get = vi.spyOn(axios, 'get').mockImplementation(async (url, config) => {
      expect(config?.headers?.Authorization).toBe(`Bearer ${token}`);
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/profile') return { status: 200, data: { id: accountId } };
      if (path === '/v2/account/settings') return { status: 200, data: { content: settings, version: 1 } };
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'e2ee', version: 1,
        signingKeyFingerprint: null, contentKeyFingerprint: computeAccountEncryptionMigrateKeyFingerprintV1(
          tweetnacl.box.keyPair.fromSecretKey(material.machineKey).publicKey), updatedAt: 1 } };
      throw new Error(`Unexpected terminal requester GET ${path}`);
    });
    const post = vi.spyOn(axios, 'post').mockImplementation(async url => {
      expect(new URL(String(url)).pathname).toBe(`/v1/actions/${actionId}/execution-authorization/verify`);
      return refused
        ? { status: refused === 'invalid_token' ? 401 : 403, data: { error: refused, authorizationRefusal: 'machine_admission_after_principal' } }
        : { status: 200, data: { ok: true } };
    });
    const run = (requestPrincipal: Parameters<typeof executeExternalAction>[0]['principal']) => executeExternalAction({
      actionId, envelope, principal: requestPrincipal, surface: 'cli', executionAuthorization: authorization,
      currentMachineId: target.machineId, currentServerId: 'profile', currentAccountId: 'foreign-controller-account', currentInstallationId: 'alice-installation',
      externalActionMachineRequestPrivateKey: installation.secretKey, verifyExecutionAuthorization: async () => true,
      resolveTarget: createDaemonExternalActionTargetResolver({ credentials: { token: 'alice-custodian', encryption: null } }),
      executor: createActionExecutor(createUnavailableHostActionDeps()),
      prepareRequesterAccountContext: request => prepareRequesterAccountActionContext({ authorization: request.authorization,
        purpose: { kind: 'external_action' }, machineId: target.machineId, installationId: 'alice-installation',
        installationPrivateKey: installation.secretKey, serverId: 'profile', serverIdentityId: 'srv_home',
        serverHttpBaseUrl: 'https://home.test', isCurrent: async () => true,
        createExecutor: admitted => {
          expect(admitted.credentials.token).toBe(token);
          return createCliActionExecutorFromCredentials({ credentials: admitted.credentials,
            readCredentials: async () => await admitted.isCurrent() ? admitted.credentials : null,
            serverId: 'profile', serverApiUrl: admitted.serverHttpBaseUrl, serverIdentityId: 'srv_home', machineId: target.machineId,
            actionsSettingsProvider: { getActionsSettings: () => normalizeActionsSettingsV1(admitted.accountSettingsContext.settings.actionsSettingsV1),
              getAccountSettings: () => admitted.accountSettingsContext.settings },
            managedMachineAction: async ({ context }) => { effects++; servedContext = context; return { machines: [] }; },
          });
        },
      }),
    });
    try {
      const result = await run(principal);
      if (refused) {
        expect(result).toMatchObject({ kind: 'invalid_request', errorCode: refused, requestId: binding.requestId });
        expect(effects).toBe(0);
        return;
      }
      expect(result, JSON.stringify(result)).toMatchObject({ kind: 'response', response: { v: 2 } });
      if (result.kind !== 'response') throw new Error('Expected terminal encrypted reply');
      expect(openExternalActionResponseV2({ envelope: result.response, request: envelope, binding, material })).toMatchObject({
        ok: true, result: { machines: [] },
      });
      expect(openExternalActionResponseV2({ envelope: result.response, request: envelope,
        binding: { ...binding, authentication: { kind: 'account', tokenEpoch: authentication.tokenEpoch } }, material })).toBeNull();
      expect(servedContext).toMatchObject({ authority: 'account_automation',
        externalActionExecutionAuthorization: { binding: { accountId, authentication } } });
      expect(effects).toBe(1);
      expect(await run({ accountId, authority: 'present_user', authentication: { kind: 'account', tokenEpoch: 7 } }))
        .toMatchObject({ kind: 'invalid_request', errorCode: 'invalid_encrypted_envelope' });
      expect(effects).toBe(1);
    } finally { get.mockRestore(); post.mockRestore(); }
  });
  it('materializes an approved Saved Secret binding through the E2EE private Account receiver', async () => {
    const accountId = 'account-owner', serverId = 'srv_bindings', serverHttpBaseUrl = 'https://bindings-home.test';
    const token = `fixture.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
    const credentials = { token, encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(19) } };
    const material = { type: 'dataKey' as const, machineKey: deriveAccountMachineKeyFromRecoverySecret(credentials.encryption.secret) };
    const installation = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(21));
    const installed = { machineId: 'machine-a', installationId: 'installation-a', publicKey: encodeBase64(installation.publicKey, 'base64url') };
    const target = { kind: 'machine' as const, machineId: installed.machineId };
    const actionId = 'deployments.bindings.set';
    const detail = createDeploymentEnvironmentDetailV1();
    const ref = formatSharedSavedSecretRefV1('approved-credential');
    const selectedBinding = { purpose: 'variable' as const, phase: 'runtime' as const, name: 'SECRET',
      source: { kind: 'secret' as const, ref, resourceRevision: 1 } };
    const input = { serverId, environmentId: detail.environment.id, expectedRevision: detail.environment.revision,
      set: [selectedBinding], remove: [] };
    // App-owned approval replay replaces the historical unsigned Session origin
    // with this fresh Home Account root. The UI composed test owns that earlier hop.
    const binding = { serverIdentityId: serverId, accountId, authentication: { kind: 'account' as const, tokenEpoch: 7 },
      actionId, requestId: 'approved-secret-binding', target };
    const envelope = sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1,
      binding, material, randomBytes: tweetnacl.randomBytes, input });
    const invocation: ExternalActionRequesterInvocationV1 = { caller: { kind: 'host' }, surface: 'ui', authority: 'present_user',
      presentUserConfirmation: { actionId, inputDigest: computeActionInputApprovalDigestV1(actionId, input),
        requestId: binding.requestId, accountId, serverId, target } };
    const authorization = sealExternalActionRequesterAccountContextV1({ authorization: {
      v: 1, token: 'home-approved-secret-root', binding: { ...binding, custodianAccountId: accountId,
        machineId: installed.machineId, installationId: installed.installationId, accountEncryptionMode: 'e2ee',
        environmentId: projectExternalActionDeploymentMetadataEnvironmentIdV1(actionId, input),
        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) },
    }, credentials: encodeStoredCredentials(credentials), invocation, purpose: { kind: 'external_action' },
      installationPublicKey: installation.publicKey, randomBytes: tweetnacl.randomBytes });
    const resource = await createResourceDataKey({ credentials, mode: 'e2ee' });
    if (resource.mode !== 'e2ee') throw new Error('Expected encrypted Account Artifact fixture');
    const encode = (value: unknown) => encodeBase64(encryptWithDataKey(value, resource.dataKey));
    const settings = prepareAccountSettingsV2Content({ credentials, raw: { actionsSettingsV1: { v: 1,
      actions: { [actionId]: { approvalRequiredSurfaces: ['ui', 'agent'] } } } }, envelopeKind: 'encrypted' });
    const documents = new Map<string, Readonly<{ id: string }> & Readonly<Record<string, unknown>>>();
    documents.set(detail.environment.contentArtifactId, { id: detail.environment.contentArtifactId, ownerAccountId: accountId,
      access: 'owner', publicAudience: 'none', encryptionMode: 'e2ee', dataEncryptionKey: resource.dataEncryptionKey,
      header: encode({ kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, title: detail.content.name }),
      body: encode({ body: JSON.stringify(detail.content) }), headerVersion: 1, bodyVersion: 1,
      seq: 1, createdAt: 1, updatedAt: 1 });
    for (const { targetLink, content } of detail.targetLinks) {
      documents.set(targetLink.contentArtifactId, { id: targetLink.contentArtifactId, ownerAccountId: accountId,
        access: 'owner', publicAudience: 'none', encryptionMode: 'e2ee', dataEncryptionKey: resource.dataEncryptionKey,
        header: encode({ kind: DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1, title: detail.content.name }),
        body: encode({ body: JSON.stringify(content) }), headerVersion: targetLink.contentHeaderVersion,
        bodyVersion: targetLink.contentBodyVersion, seq: 1, createdAt: 1, updatedAt: 1 });
    }
    const storedSecret = sealSavedSecretResourceStoredContentV1({ resourceId: 'approved-credential', mode: 'e2ee',
      content: { v: 1, name: 'Credential', kind: 'token', value: 'private-binding-value' },
      resourceDataKey: resource.dataKey, randomBytes: getRandomBytes });
    const writes: ReturnType<typeof DeploymentBindingsSetStorageInputV1Schema.parse>[] = [];
    let materialReads = 0;
    const phaseFailures: string[] = [];
    const phases = vi.spyOn(logger, 'warnLocalFile').mockImplementation((message, details) => {
      if (message === '[external-action-phase]' && details && typeof details === 'object' && 'phase' in details) {
        phaseFailures.push(String(details.phase));
      }
    });
    // Only Home HTTP and installed identity are substituted. Private opening,
    // requester Settings custody, policy, Saved Secret materialization and grants are real.
    const identity = vi.spyOn(installationIdentity, 'readInstallationIdentityIfExistsSync').mockReturnValue({ version: 1,
      installationId: installed.installationId, publicKey: installed.publicKey,
      privateKey: encodeBase64(installation.secretKey, 'base64url'), createdAt: 1 });
    const get = vi.spyOn(axios, 'get').mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/profile') return { status: 200, data: { id: accountId } };
      if (path === '/v2/account/settings') return { status: 200, data: { content: settings, version: 1 } };
      if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'e2ee', updatedAt: 1 } };
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'e2ee', version: 1,
        signingKeyFingerprint: null, contentKeyFingerprint: computeAccountEncryptionMigrateKeyFingerprintV1(
          tweetnacl.box.keyPair.fromSecretKey(material.machineKey).publicKey), updatedAt: 1 } };
      if (path === '/v1/account/saved-secrets/resources/materials') {
        materialReads++;
        return { status: 200, data: { resources: [{ resourceId: 'approved-credential', encryptionMode: 'e2ee',
          recipientEnvelope: { encryptedDataKey: resource.dataEncryptionKey, recipientContentPublicKeyFingerprint: 'owner-content-key' },
          entry: { ref, source: 'shared_resource', relationship: 'owner', name: 'Credential', kind: 'token', ownerAccountId: accountId,
            revision: 1, materialStatus: 'ready', capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } },
          storedContent: storedSecret }] } };
      }
      if (path.startsWith('/v1/artifacts/')) {
        const document = documents.get(decodeURIComponent(path.split('/').at(-1)!));
        return { status: document ? 200 : 404, data: document ?? {} };
      }
      throw new Error(`Unexpected binding HTTP GET ${path}`);
    });
    const post = vi.spyOn(axios, 'post').mockImplementation(async (url, raw: unknown) => {
      const path = new URL(String(url)).pathname;
      if (path === `/v1/actions/${actionId}/execution-authorization/verify`) return { status: 200, data: { ok: true } };
      if (path === '/v1/artifacts/read') return artifactReadResponse(raw, id => documents.get(id) ?? null);
      if (path === '/v1/artifacts' && raw && typeof raw === 'object' && 'id' in raw && typeof raw.id === 'string') {
        documents.set(raw.id, { ...raw, ownerAccountId: accountId, access: 'owner', publicAudience: 'none', encryptionMode: 'e2ee',
          headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 });
        return { status: 200, data: { id: raw.id, headerVersion: 1, bodyVersion: 1 } };
      }
      throw new Error(`Unexpected binding HTTP POST ${path}`);
    });
    const request = vi.spyOn(axios, 'request').mockImplementation(async config => {
      const path = new URL(config.url!).pathname;
      if (path.endsWith('/secret-launch-admission')) return { status: 200, data: { ok: true, grants: [],
        bindingPreparation: { runtimeInstallations: [installed], buildInstallation: installed } } };
      if (config.method === 'POST' && path.endsWith('/bindings')) {
        writes.push(DeploymentBindingsSetStorageInputV1Schema.parse(config.data));
        return { status: 200, data: { ok: true, environmentId: detail.environment.id, revision: detail.environment.revision + 1 } };
      }
      if (config.method === 'GET' && path.endsWith(`/environments/${detail.environment.id}`)) return { status: 200,
        data: { ok: true, environment: detail.environment, targetLinks: detail.targetLinks.map(value => value.targetLink) } };
      throw new Error(`Unexpected binding HTTP ${config.method} ${path}`);
    });
    try {
      const resolveRequesterIdentity = async () => selectHostRequesterExecutionIdentity({ hostHomeServerIdentityId: serverId,
        hostAccountAutomation: { accountId, custodianAccountId: accountId, machineId: installed.machineId, installationId: installed.installationId } });
      const host = { credentials, serverId, serverHttpBaseUrl, machineId: installed.machineId, resolveRequesterIdentity };
      const runtime = createOwnServerDeploymentRuntimeForHost({ ...host, async acquirePluginRuntimeRegistryLease() {
        const lease = pluginReloadController.tryAcquireRuntimeRegistry();
        if (!lease) throw new Error('No installed native plugin runtime');
        return lease;
      } });
      const native = createRequesterBoundDeploymentActionDeps({ ...host, runtime });
      const operations = createHostActionOperationRuntime({ serverId, machineId: installed.machineId,
        custodyBinding: { serverId, installationId: installed.installationId }, resolveAccountId: async () => accountId });
      const verify = (request: Parameters<typeof verifyExternalActionExecutionAuthorizationCurrent>[0]) =>
        verifyExternalActionExecutionAuthorizationCurrent({ ...request, privateKey: installation.secretKey,
          installationId: installed.installationId, serverHttpBaseUrl });
      const result = await executeExternalAction({ actionId, envelope, executionAuthorization: authorization,
        principal: { accountId, authority: 'present_user', authentication: binding.authentication },
        currentMachineId: installed.machineId, currentServerId: serverId, currentServerHttpBaseUrl: serverHttpBaseUrl,
        currentInstallationId: installed.installationId, externalActionMachineRequestPrivateKey: installation.secretKey,
        verifyExecutionAuthorization: request => verify({ ...request, privateKey: installation.secretKey,
          installationId: installed.installationId, serverHttpBaseUrl }),
        resolveTarget: createDaemonExternalActionTargetResolver({ credentials }), executor: createActionExecutor(createUnavailableHostActionDeps()),
        prepareRequesterAccountContext: request => prepareRequesterAccountActionContext({ authorization: request.authorization,
          purpose: { kind: 'external_action' }, machineId: installed.machineId, installationId: installed.installationId,
          installationPrivateKey: installation.secretKey, serverId, serverIdentityId: serverId, serverHttpBaseUrl,
          isCurrent: () => verify({ authorization: request.authorization, effectActionId: actionId, target,
            privateKey: installation.secretKey, installationId: installed.installationId, serverHttpBaseUrl }),
          createExecutor: admitted => createCliActionExecutorFromCredentials({ credentials: admitted.credentials,
            serverId, serverIdentityId: serverId, serverApiUrl: serverHttpBaseUrl, machineId: installed.machineId,
            externalActionMachineRequestPrivateKey: installation.secretKey, externalActionMachineInstallationId: installed.installationId,
            runActionOperation: operations.runActionOperation,
            ...native, actionsSettingsProvider: { getActionsSettings: () => normalizeActionsSettingsV1(admitted.accountSettingsContext.settings.actionsSettingsV1),
              getAccountSettings: () => admitted.accountSettingsContext.settings } }),
        }),
      });
      expect(result, JSON.stringify({ kind: result.kind, ...(result.kind === 'invalid_request'
        ? { errorCode: result.errorCode } : {}), phaseFailures })).toMatchObject({ kind: 'response' });
      if (result.kind !== 'response') throw new Error(`Binding refused before effect: ${result.errorCode}`);
      const opened = openExternalActionResponseV2({ envelope: result.response, request: envelope, binding, material });
      expect(opened, JSON.stringify({ opened, errorCode: opened && !opened.ok ? opened.errorCode : null,
        phaseFailures, materialReads, bindingWrites: writes.length }))
        .toMatchObject({ ok: true, result: { ok: true, environmentId: detail.environment.id } });
      expect(writes).toHaveLength(1);
      expect(materialReads).toBe(1);
      const grants: MachineSecretGrantV1[] = writes[0]!.grants;
      const launch = await prepareEnvironmentSecretBindingsForLaunch({ environmentId: detail.environment.id,
        machineId: installed.machineId, installationId: installed.installationId, installationPrivateSeed: installation.secretKey.subarray(0, 32),
        phase: 'runtime', bindings: [selectedBinding], grants, async assertCurrent() {} });
      expect(launch.env.SECRET === 'private-binding-value').toBe(true);
      launch.dispose();
      expect(JSON.stringify(opened).includes('private-binding-value')).toBe(false);
    } finally { request.mockRestore(); post.mockRestore(); get.mockRestore(); identity.mockRestore(); phases.mockRestore(); }
  });
  it.each(['present-user', 'plugin', 'bounded-plugin', 'inherited-plugin', 'missing'] as const)('admits %s private origin through requester custody into the real transition coordinator', async kind => {
    const accountId = 'transition-account';
    const token = `fixture.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
    const installation = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(23));
    const target = { kind: 'machine' as const, machineId: 'controller' };
    const actionId = 'session.agent.transition';
    const sessionId = 'c123456789012345678901234';
    const inputMeta: Record<string, string> = kind === 'inherited-plugin' ? {} : { permissionMode: kind === 'bounded-plugin' ? 'read-only' : 'yolo' };
    const envelope = { v: 1 as const, requestId: `transition-${kind}`, target, input: { sessionId,
      expectedCurrentAgentId: 'claude', selection: { v: 1, agentId: 'codex' },
      input: { localId: 'first-input', text: 'Continue', meta: inputMeta } } };
    const invocation: ExternalActionRequesterInvocationV1 | undefined = kind === 'missing' ? undefined : kind.includes('plugin')
      ? { caller: { kind: 'plugin', pluginId: 'acme.switch', contributionLocalId: 'switch' }, surface: 'plugin',
        authority: 'account_automation', callerPermissionMode: 'read-only', callerInputConstraints: { models: null, permissionModes: ['read-only'] } }
      : { caller: { kind: 'host' }, surface: 'ui', authority: 'present_user' };
    const authorization = sealExternalActionRequesterAccountContextV1({ authorization: { v: 1, token: 'home-proof', binding: {
      accountId, custodianAccountId: accountId, authentication: { kind: 'account', tokenEpoch: 7 },
      accountEncryptionMode: 'plain', serverIdentityId: 'srv_home', machineId: target.machineId, installationId: 'installation',
      actionId, requestId: envelope.requestId, target, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
    } }, credentials: { token }, ...(invocation ? { invocation } : {}), purpose: { kind: 'external_action' },
      installationPublicKey: installation.publicKey, randomBytes: tweetnacl.randomBytes });
    let featureReads = 0;
    resetServerFeaturesClientForTests();
    const fetchBoundary = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      featureReads++;
      return new Response(JSON.stringify({ features: { sessions: { enabled: true, agentSwitching: { enabled: false } } }, capabilities: {} }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    });
    // Only HTTP is substituted: private opening, requester admission, Action policy and coordinator are real.
    const get = vi.spyOn(axios, 'get').mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/profile') return { status: 200, data: { id: accountId } };
      if (path === '/v2/account/settings') return { status: 200, data: { content: { t: 'plain', v: {
        actionsSettingsV1: { v: 1, actions: {}, approvalWaivedSurfaces: { [actionId]: ['ui', 'plugin'] } },
      } }, version: 1 } };
      if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'plain', version: 1,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      if (path === `/v2/sessions/${sessionId}`) return { status: 200, data: { session: {
        id: sessionId, seq: 1, createdAt: 1, updatedAt: 1, active: false, activeAt: 1, encryptionMode: 'plain',
        metadata: JSON.stringify({ machineId: target.machineId, flavor: 'claude' }), metadataVersion: 1,
        agentState: null, agentStateVersion: 0, dataEncryptionKey: null,
      } } };
      if (path === '/v1/features') { featureReads++; return { status: 200, data: { features: { sessions: { enabled: true,
        agentSwitching: { enabled: false } } }, capabilities: {} } }; }
      throw new Error(`Unexpected HTTP GET ${path}`);
    });
    const post = vi.spyOn(axios, 'post').mockImplementation(async url => {
      if (new URL(String(url)).pathname === `/v1/actions/${actionId}/execution-authorization/verify`) return { status: 200, data: { ok: true } };
      throw new Error(`Unexpected HTTP POST ${String(url)}`);
    });
    try {
      const result = await executeExternalAction({ actionId, envelope, executionAuthorization: authorization,
        principal: { accountId, authority: 'present_user', authentication: { kind: 'account', tokenEpoch: 7 } },
        currentMachineId: target.machineId, currentServerId: 'profile', currentServerHttpBaseUrl: 'https://home.test',
        currentInstallationId: 'installation', externalActionMachineRequestPrivateKey: installation.secretKey,
        verifyExecutionAuthorization: async () => true, resolveTarget: createDaemonExternalActionTargetResolver({ credentials: { token, encryption: null } }),
        executor: createActionExecutor(createUnavailableHostActionDeps()),
        prepareRequesterAccountContext: request => prepareRequesterAccountActionContext({ authorization: request.authorization,
          purpose: { kind: 'external_action' }, machineId: target.machineId, installationId: 'installation',
          installationPrivateKey: installation.secretKey, serverId: 'profile', serverIdentityId: 'srv_home',
          serverHttpBaseUrl: 'https://home.test', isCurrent: async () => true,
          createExecutor: admitted => createCliActionExecutorFromCredentials({ credentials: admitted.credentials,
            serverId: 'profile', serverApiUrl: admitted.serverHttpBaseUrl, serverIdentityId: 'srv_home', machineId: target.machineId,
            externalActionMachineRequestPrivateKey: installation.secretKey, externalActionMachineInstallationId: 'installation',
            actionsSettingsProvider: { getActionsSettings: () => normalizeActionsSettingsV1(admitted.accountSettingsContext.settings.actionsSettingsV1),
              getAccountSettings: () => admitted.accountSettingsContext.settings },
          }),
        }),
      });
      if (kind === 'present-user' || kind === 'bounded-plugin' || kind === 'inherited-plugin') {
        expect(result, JSON.stringify(result)).toMatchObject({ kind: 'response', response: { execution: { ok: true, result: { type: 'rejected', code: 'unsupported_operation' } } } });
        expect(featureReads).toBeGreaterThan(0);
      } else {
        expect(result, JSON.stringify(result)).toMatchObject({ kind: 'response', response: { execution: kind === 'missing'
          ? { ok: false, errorCode: 'forbidden' } : { ok: true, result: { type: 'rejected', code: 'forbidden', sourceEffect: 'none' } } } });
        expect(featureReads).toBe(0);
      }
    } finally { get.mockRestore(); post.mockRestore(); fetchBoundary.mockRestore(); resetServerFeaturesClientForTests(); }
  });
  it.each(['default', 'yolo'] as const)('keeps authenticated API-token %s input inside its grant at the real transition coordinator', async permissionMode => {
    let featureReads = 0;
    resetServerFeaturesClientForTests();
    const fetchBoundary = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      featureReads++;
      return new Response(JSON.stringify({ features: { sessions: { enabled: true, agentSwitching: { enabled: false } } }, capabilities: {} }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    });
    try {
      const settings = normalizeActionsSettingsV1({ v: 1, actions: {}, approvalWaivedSurfaces: { 'session.agent.transition': ['api'] } });
      const executor = createCliActionExecutor({ token: 'api-credential', credentials: { token: 'api-credential', encryption: null }, sessionId: '', mode: 'plain', ctx: null,
        actionsSettingsProvider: { getActionsSettings: () => settings } });
      const result = await executor.execute('session.agent.transition', {
        sessionId: 'session-1', expectedCurrentAgentId: 'claude', selection: { v: 1, agentId: 'codex' },
        input: { localId: 'first-input', text: 'Continue', meta: { permissionMode } },
      }, { actionCaller: { kind: 'host' }, surface: 'api', authority: 'account_automation',
        actionsSettings: normalizeActionsSettingsV1({ v: 1, actions: {}, approvalWaivedSurfaces: { 'session.agent.transition': ['api'] } }),
        externalActionCredential: { accountId: principal.accountId, principalId: principal.principalId, credentialId: principal.credentialId,
          grant: { ...API_TOKEN_FULL_GRANT_V1, permissionModes: ['default'] } },
      });
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { type: 'rejected',
        code: permissionMode === 'default' ? 'unsupported_operation' : 'forbidden', sourceEffect: 'none' } });
      expect(featureReads).toBe(permissionMode === 'default' ? 1 : 0);
    } finally { fetchBoundary.mockRestore(); resetServerFeaturesClientForTests(); }
  });
  it('does not expose a parallel raw machine switching mutation', async () => {
    const { call } = createEncryptedRpcTestClient({ scopePrefix: 'private-transition',
      registerHandlers: manager => registerSessionAgentTransitionRpcHandlers(manager, {
        readCredentials: async () => ({ token: 'host-account', encryption: null }),
      }),
    });
    const result = await call(RPC_METHODS.SESSION_AGENT_TRANSITION, { v: 1, sessionId: 'session-1',
      expectedCurrentAgentId: 'claude', selection: { v: 1, agentId: 'codex' },
      input: { localId: 'first-input', text: 'Continue', meta: {} } });
    expect(result).toMatchObject({ errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND });
  });
  it('does not promote a raw resolved Session context without admitted private requester custody', async () => {
    const accountId = 'unadmitted-session';
    const credentials = { token: `fixture.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`, encryption: null };
    const key = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(23));
    const authorization = { v: 1 as const, token: 'unadmitted-root', binding: { accountId, custodianAccountId: accountId,
      authentication: { kind: 'account' as const, tokenEpoch: 7 }, serverIdentityId: 'srv_home', machineId: 'controller', installationId: 'installation',
      actionId: 'session.agent.transition', requestId: 'request', requestEnvelopeDigest: 'A'.repeat(43), target: { kind: 'machine' as const, machineId: 'controller' } } };
    const executor = createCliActionExecutor({ token: credentials.token, credentials, sessionId: '', serverId: 'profile', mode: 'plain', ctx: null,
      serverIdentityId: 'srv_home', serverHttpBaseUrl: 'https://home.test', externalActionMachineRequestPrivateKey: key.secretKey,
      externalActionMachineInstallationId: 'installation', actionsSettingsProvider: { getActionsSettings: () => normalizeActionsSettingsV1({
        v: 1, actions: {}, approvalWaivedSurfaces: { 'session.agent.transition': ['ui'] } }) } });
    const result = await executor.execute('session.agent.transition', { sessionId: 'session-1', expectedCurrentAgentId: 'claude',
      selection: { v: 1, agentId: 'codex' }, input: { localId: 'unadmitted-input', text: 'Continue', meta: {} } }, {
      surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, runtimeAccountId: accountId, actionRequestId: 'request',
      defaultSessionMachineId: 'controller', defaultSessionId: 'session-1', externalActionTarget: { kind: 'session', sessionId: 'session-1' },
      externalActionExecutionAuthorization: authorization,
    });
    expect(result).toMatchObject({ ok: true, result: { type: 'rejected', code: 'forbidden', sourceEffect: 'none' } });
  });
  it.each([
    ['foreign', 'present_user', 'account'], ['own', 'account_automation', 'account'],
    ['foreign', 'account_automation', 'account'], ['own', 'account_automation', 'terminal'],
  ] as const)('enforces controller credential custody and preserves own-Account Ask through the private requester factory for %s %s %s', async (custody, authority, authenticationKind) => {
    const accountId = 'bob-private-ask';
    const custodianAccountId = custody === 'own' ? accountId : 'alice';
    const token = `fixture.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
    const credentials = { token, encryption: null };
    const installation = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(22));
    const target = { kind: 'machine' as const, machineId: 'alice-controller' };
    const actionId = 'machines.managed.acquire';
    const input = { enrollmentIdentity, selection: { kind: 'one-off' as const, homeId: 'srv_home',
      controller: { machineId: target.machineId, installationId: 'alice-installation' },
      launch: { provider: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: {} },
      retention: { kind: 'until-delete' as const }, wakeOnAcceptedMessage: false } };
    const principal = { accountId, authority, authentication: { kind: authenticationKind, tokenEpoch: 7 } };
    const envelope = { v: 1 as const, requestId: 'bob-reviewed-request', input, target };
    const sealRequester = () => sealExternalActionRequesterAccountContextV1({
      authorization: ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-admitted-bob', binding: {
        accountId, authentication: principal.authentication, accountEncryptionMode: 'plain', serverIdentityId: 'srv_home',
        machineId: target.machineId, custodianAccountId, installationId: 'alice-installation',
        actionId, requestId: envelope.requestId, target, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
      } }), credentials: { token }, purpose: { kind: 'external_action' }, installationPublicKey: installation.publicKey,
      randomBytes: tweetnacl.randomBytes,
    });
    if (custody === 'foreign') {
      // Managed controllers receive the compute codec, never another Account's
      // credentials. The replay matrix below exercises that admitted codec.
      expect(sealRequester).toThrow('managed_controller_credentials_forbidden');
      return;
    }
    const authorization = sealRequester();
    const storedSettings = { actionsSettingsV1: { v: 1, ...(authority === 'present_user' ? {
      actions: { [actionId]: { approvalRequiredSurfaces: ['ui'] } },
    } : {}) } };
    const aliceSnapshot = { source: 'network' as const, settings: accountSettingsParse({}), rawSettings: {}, settingsVersion: 1,
      loadedAtMs: Date.now(), settingsSecretsReadKeys: [], scopeKey: 'alice-custodian' };
    setActiveAccountSettingsSnapshot(aliceSnapshot);
    let effects = 0;
    const approvals: ApprovalRequest[] = [];
    const approvalArtifacts = new Map<string, Record<string, unknown>>();
    // HTTP is the only substituted owner. Private credential opening,
    // requester admission, policy, receiver signing and Artifact codec stay real.
    const get = vi.spyOn(axios, 'get').mockImplementation(async (url, config) => {
      expect(config?.headers?.Authorization).toBe(`Bearer ${token}`);
      if (String(url).endsWith('/v1/account/profile')) return { status: 200, data: { id: accountId } };
      if (String(url).endsWith('/v2/account/settings')) return { status: 200, data: { content: { t: 'plain', v: storedSettings }, version: 2 } };
      if (String(url).endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      if (String(url).endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
        mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
      } };
      if (new URL(String(url)).pathname.startsWith('/v1/artifacts/')) {
        const artifact = approvalArtifacts.get(new URL(String(url)).pathname.split('/').at(-1)!);
        return artifact ? { status: 200, data: artifact } : { status: 404, data: { error: 'not_found' } };
      }
      throw new Error(`Unexpected requester GET: ${String(url)}`);
    });
    const post = vi.spyOn(axios, 'post').mockImplementation(async (url, raw: unknown) => {
      if (new URL(String(url)).pathname === `/v1/actions/${actionId}/execution-authorization/verify`) return { status: 200, data: { ok: true } };
      expect(new URL(String(url)).pathname).toBe('/v1/artifacts');
      if (!raw || typeof raw !== 'object' || !('id' in raw) || !('body' in raw)) throw new Error('Malformed requester Artifact');
      const body = typeof raw.body === 'string' ? decodePlainArtifactStoredContent(raw.body) : null;
      if (!body || typeof body !== 'object' || !('body' in body) || typeof body.body !== 'string') throw new Error('Missing private approval');
      approvals.push(ApprovalRequestV2Schema.parse(JSON.parse(body.body)));
      approvalArtifacts.set(String(raw.id), { ...raw, ownerAccountId: accountId, access: 'owner', encryptionMode: 'plain',
        publicAudience: 'none', dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
        headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 });
      return { status: 200, data: { id: raw.id, headerVersion: 1, bodyVersion: 1 } };
    });
    try {
      const result = await executeExternalAction({ actionId, envelope, principal, executionAuthorization: authorization,
        currentMachineId: target.machineId, currentServerId: 'profile', currentInstallationId: 'alice-installation',
        externalActionMachineRequestPrivateKey: installation.secretKey, verifyExecutionAuthorization: async () => true,
        resolveTarget: createDaemonExternalActionTargetResolver({ credentials: { token: 'alice-custodian', encryption: null } }),
        executor: createActionExecutor(createUnavailableHostActionDeps()),
        prepareRequesterAccountContext: request => prepareRequesterAccountActionContext({ authorization: request.authorization,
          purpose: { kind: 'external_action' }, machineId: target.machineId, installationId: 'alice-installation',
          installationPrivateKey: installation.secretKey, serverId: 'profile', serverIdentityId: 'srv_home',
          serverHttpBaseUrl: 'https://home.test', isCurrent: async () => true,
          createExecutor: admitted => createCliActionExecutorFromCredentials({ credentials: admitted.credentials,
            readCredentials: async () => await admitted.isCurrent() ? admitted.credentials : null,
            serverId: 'profile', serverApiUrl: admitted.serverHttpBaseUrl, serverIdentityId: 'srv_home', machineId: target.machineId,
            externalActionMachineRequestPrivateKey: installation.secretKey, externalActionMachineInstallationId: 'alice-installation',
            actionsSettingsProvider: { getActionsSettings: () => normalizeActionsSettingsV1(admitted.accountSettingsContext.settings.actionsSettingsV1),
              getAccountSettings: () => admitted.accountSettingsContext.settings },
            managedMachineAction: async () => { effects++; return { managedId: 'retained' }; },
          }),
        }),
      });
      expect(result, JSON.stringify(result)).toMatchObject({ kind: 'response', response: { execution: { ok: true,
        result: { kind: 'approval_request_created', actionId } } } });
      expect(effects).toBe(0);
      expect(approvals).toHaveLength(1);
      expect(approvals[0]).toMatchObject({ status: 'open', executionOriginV1: {
        surface: authenticationKind === 'terminal' ? 'cli' : 'ui', authority, accountId,
        externalActionExecutionAuthorization: { binding: { accountId, custodianAccountId } } } });
      expect(JSON.stringify(approvals[0])).not.toContain(token);
      expect(getActiveAccountSettingsSnapshot()).toBe(aliceSnapshot);
    } finally { get.mockRestore(); post.mockRestore(); resetActiveAccountSettingsSnapshotForTests(); }
  });

  it('preserves own original Account Project HTTP custody without inventing a requester box', async () => {
    const installation = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(27));
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'own-account' })).toString('base64url')}.signature`;
    const credentials = { token, encryption: null };
    setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}),
      rawSettings: { privateOwnPublicationMarker: 'unchanged' }, settingsVersion: 9, loadedAtMs: 1, settingsSecretsReadKeys: [],
      scopeKey: resolveAccountSettingsScopeKey(credentials) });
    const ownSnapshot = getActiveAccountSettingsSnapshot();
    const principal = { accountId: 'own-account', authority: 'present_user' as const,
      authentication: { kind: 'account' as const, tokenEpoch: 1 } };
    const actionId = 'projects.visibility.set';
    const target = { kind: 'machine' as const, machineId: 'own-machine' };
    const input = { target: { serverId: 'own-home', projectKey: 'project' }, expectedRevision: 2, hidden: false };
    const envelope = { v: 1 as const, requestId: 'own-project-request', target, input };
    const authorization = { v: 1 as const, token: 'own-home-root', binding: { accountId: principal.accountId,
      custodianAccountId: principal.accountId, authentication: principal.authentication, accountEncryptionMode: 'plain' as const,
      serverIdentityId: 'srv_own', machineId: target.machineId, installationId: 'own-installation',
      actionId, requestId: envelope.requestId, target, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) } };
    let row = ProjectAccountRowV1Schema.parse({ key: { kind: 'project-organization', serverId: 'own-home', projectKey: 'project' },
      revision: 2, content: { t: 'plain', v: { key: { kind: 'project-organization', serverId: 'own-home', projectKey: 'project' },
        value: { hidden: true, pinned: false, promptStack: [] } } } });
    const initialRow = row;
    const get = vi.spyOn(axios, 'get').mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/profile') return { status: 200, data: { id: principal.accountId } };
      if (path === '/v2/account/settings') return { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'plain', version: 1,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      throw new Error(`Unexpected own Project GET ${path}`);
    });
    const post = vi.spyOn(axios, 'post').mockImplementation(async (url, body: unknown, config) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith('/execution-authorization/verify')) return { status: 200, data: { ok: true } };
      expect(config?.headers).not.toHaveProperty('Authorization');
      expect(config?.headers?.[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]).toBe(authorization.token);
      expect(config?.headers?.[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]).toEqual(expect.any(String));
      if (path === '/v1/account/project-rows/list') return { status: 200, data: { status: 'listed', coverage: 'complete', rows: [row] } };
      if (path === '/v1/account/project-rows/read') return projectAccountRowReadResponse([row], body);
      if (path === '/v1/account/project-rows/mutate') {
        const request = ProjectAccountRowMutationRequestV1Schema.parse(body);
        const mutation = request.mutations[0]!;
        expect(mutation.expectedRevision).toBe(row.revision);
        row = ProjectAccountRowV1Schema.parse({ key: mutation.key, revision: row.revision + 1, content: mutation.content });
        return { status: 200, data: { status: 'updated', rows: [row], cursor: row.revision } };
      }
      throw new Error(`Unexpected own Project POST ${path}`);
    });
    const createExecutor = () => createActionExecutor(createCliActionDeps({ token, credentials, sessionId: 'cli-global', mode: 'plain', ctx: null,
      serverId: 'own-home', serverHttpBaseUrl: 'https://own-home.test' }));
    try {
      const run = (authority: 'present_user' | 'account_automation') => {
        const authentication = authority === 'present_user' ? principal.authentication : { kind: 'terminal' as const, tokenEpoch: 1 };
        return executeExternalAction({ actionId, envelope,
        principal: { ...principal, authority, authentication }, executionAuthorization: ExternalActionExecutionAuthorizationV1Schema.parse({
          ...authorization, binding: { ...authorization.binding, authentication },
        }),
        currentMachineId: target.machineId, currentServerId: 'own-home', currentServerHttpBaseUrl: 'https://own-home.test',
        currentInstallationId: 'own-installation', externalActionMachineRequestPrivateKey: installation.secretKey,
        verifyExecutionAuthorization: async () => true, resolveTarget: createDaemonExternalActionTargetResolver({ credentials }), executor: createExecutor(),
        prepareRequesterAccountContext: async ({ authorization: root, purpose, signal }) => {
          const admission = { authorization: root, purpose: purpose ?? { kind: 'external_action' as const },
            machineId: target.machineId, installationId: 'own-installation', installationPrivateKey: installation.secretKey,
            serverId: 'own-home', serverIdentityId: 'srv_own', serverHttpBaseUrl: 'https://own-home.test',
            ownCredentials: credentials, isCurrent: async () => true, signal, createExecutor };
          return await prepareRequesterAccountActionContext(admission);
        },
      });
      };
      const executed = await run('present_user');
      expect(executed, JSON.stringify(executed)).toMatchObject({ kind: 'response', response: { execution: {
        ok: true, result: { row: { hidden: false }, revision: 3 },
      } } });
      expect(JSON.stringify(authorization)).not.toContain('requesterAccountContext');
      expect(getActiveAccountSettingsSnapshot()).toBe(ownSnapshot);
      row = initialRow;
      expect(await run('account_automation')).toMatchObject({ kind: 'response', response: { execution: {
        ok: true, result: { row: { hidden: false }, revision: 3 },
      } } });
    } finally { get.mockRestore(); post.mockRestore(); resetActiveAccountSettingsSnapshotForTests(); }
  });
  it('opens arbitrary requester custody only after Home admission and supplies Bob private crypto to the real executor', async () => {
    const installation = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(22));
    const bob = { token: 'bob-private', encryption: null };
    const accountPrincipal = { accountId: 'bob', authority: 'present_user' as const,
      authentication: { kind: 'account' as const, tokenEpoch: 1 } };
    const target = { kind: 'machine' as const, machineId: 'alice-machine' };
    const envelope = { v: 1 as const, requestId: 'private-request', target, input: { message: 'Private result' } };
    const actionId = 'notifications.notify_me';
    const authorization = sealExternalActionRequesterAccountContextV1({
      authorization: { v: 1, token: 'home-root', binding: { accountId: 'bob', custodianAccountId: 'alice',
        authentication: accountPrincipal.authentication, accountEncryptionMode: 'plain', serverIdentityId: 'home',
        machineId: target.machineId, installationId: 'installation', actionId, requestId: envelope.requestId, target,
        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) } },
      credentials: { token: bob.token }, purpose: { kind: 'external_action' }, installationPublicKey: installation.publicKey,
      randomBytes: tweetnacl.randomBytes,
    });
    let homeCurrent = true;
    let retired: (() => Promise<boolean>) | undefined;
    let deliveredTo: string | undefined;
    const get = vi.spyOn(axios, 'get').mockImplementation(async (url, config) => {
      expect(config?.headers?.Authorization).toBe('Bearer bob-private');
      if (String(url).endsWith('/v1/account/profile')) return { status: 200, data: { id: 'bob' } };
      if (String(url).endsWith('/v2/account/settings')) return { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
      if (String(url).endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
        mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
      } };
      throw new Error('Unexpected requester read');
    });
    const post = vi.spyOn(axios, 'post').mockImplementation(async url => {
      expect(String(url)).toBe(`https://home.test/v1/actions/${actionId}/execution-authorization/verify`);
      return { status: homeCurrent ? 200 : 403, data: { ok: homeCurrent } };
    });
    const run = () => executeExternalAction({ actionId, envelope, principal: accountPrincipal, surface: 'cli',
      currentMachineId: target.machineId, currentServerId: 'profile', currentInstallationId: 'installation',
      executionAuthorization: authorization, externalActionMachineRequestPrivateKey: installation.secretKey,
      verifyExecutionAuthorization: async () => homeCurrent,
      resolveTarget: createDaemonExternalActionTargetResolver({ credentials: { token: 'alice-custodian', encryption: null } }),
      executor: createActionExecutor(createUnavailableHostActionDeps()),
      prepareRequesterAccountContext: async ({ authorization: root }) => {
        return await prepareRequesterAccountActionContext({ authorization: root, purpose: { kind: 'external_action' },
          machineId: target.machineId, installationId: 'installation', installationPrivateKey: installation.secretKey,
          serverId: 'profile', serverIdentityId: 'home', serverHttpBaseUrl: 'https://home.test', isCurrent: async () => homeCurrent,
          createExecutor: admitted => {
            retired = admitted.isCurrent;
            // The private runtime owns credentials, but Project effects still require original Home HTTP authority on the carrier.
            return createActionExecutor({ ...createUnavailableHostActionDeps(),
            // Notification delivery is the external boundary; admission and crypto owners stay real.
            notificationsNotifyMe: async (_input, context) => {
              deliveredTo = context.externalActionExecutionAuthorization?.requesterAccountProjection?.accountId;
              expect(context.externalActionExecutionAuthorization?.requesterHttpProjection?.accountId).toBe('bob');
              expect(JSON.stringify(context.externalActionExecutionAuthorization)).not.toContain('requesterAccountContext');
              return { attemptedChannels: 1, deliveredChannels: deliveredTo === 'bob' ? 1 : 0 };
            } });
          },
        });
      },
    });
    try {
      const executed = await run();
      expect(executed, JSON.stringify(executed)).toMatchObject({ kind: 'response', response: { execution: {
        ok: true, result: { attemptedChannels: 1, deliveredChannels: 1 },
      } } });
      expect(deliveredTo).toBe('bob');
      expect(await retired?.()).toBe(false);
      homeCurrent = false;
      expect(await run()).toMatchObject({ kind: 'invalid_request', errorCode: 'invalid_envelope' });
    } finally { get.mockRestore(); post.mockRestore(); }
  });
  it.each([
    ['current', 'prepare', 'present_user'], ['current', 'execute', 'present_user'],
    ['newly persisted', 'prepare', 'present_user'], ['newly persisted', 'execute', 'present_user'],
    ['refused by Home', 'prepare', 'present_user'],
    ['invalid settings', 'execute', 'present_user'],
    ['current', 'execute', 'account_automation'], ['newly persisted', 'prepare', 'account_automation'],
  ] as const)('preserves signed own-Account UI authority and %s review before native %s for %s', async (policy, operation, authority) => {
    vi.stubEnv('HAPPIER_ACCOUNT_SETTINGS_MODE', 'auto');
    const accountId = 'ask-fresh-account';
    const token = `fixture.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
    const credentials = { token, encryption: null };
    const privateKey = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(8)).secretKey;
    const actionId = 'machines.managed.acquire';
    const target = { kind: 'machine' as const, machineId: 'controller' };
    const input = { enrollmentIdentity, selection: { kind: 'one-off' as const, homeId: 'srv_home',
      controller: { machineId: target.machineId, installationId: 'installation' },
      launch: { provider: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: {} },
      retention: { kind: 'until-delete' as const }, wakeOnAcceptedMessage: false } };
    const principal = { accountId, authority, authentication: { kind: 'account' as const, tokenEpoch: 7 } };
    const envelope = { v: 1 as const, requestId: 'fresh-ask', input, target };
    const authorization = { v: 1 as const, token: 'signed-account-root', binding: {
      accountId, authentication: principal.authentication, accountEncryptionMode: 'plain' as const,
      serverIdentityId: 'srv_home', machineId: target.machineId, custodianAccountId: accountId,
      installationId: 'installation', actionId, requestId: envelope.requestId, target,
      requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
    } };
    const storedSettings = { actionsSettingsV1: { v: 1, actions: { [actionId]: { approvalRequiredSurfaces: ['ui'] } } } };
    const snapshotSettings = policy === 'newly persisted' ? {} : storedSettings;
    setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse(snapshotSettings), rawSettings: snapshotSettings, settingsVersion: 1,
      loadedAtMs: Date.now(), settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) });
    let effects = 0;
    const savedApprovals: ApprovalRequest[] = [];
    const approvalArtifacts = new Map<string, Record<string, unknown>>();
    // HTTP is the only substituted owner here: real credential scoping,
    // settings publication, policy, input signing and private Artifact codec run.
    const get = vi.spyOn(axios, 'get').mockImplementation(async (url, config) => {
      expect(config?.headers?.Authorization).toBe(`Bearer ${token}`);
      if (String(url).endsWith('/v2/account/settings')) return { status: 200, data: policy === 'invalid settings'
        ? { content: { t: 'plain', v: storedSettings }, version: 'PRIVATE_POLICY_RESPONSE_MUST_NOT_LEAK' }
        : { content: { t: 'plain', v: storedSettings }, version: 2 } };
      if (String(url).endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      if (String(url).endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
        mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
      } };
      if (new URL(String(url)).pathname.startsWith('/v1/artifacts/')) {
        const artifact = approvalArtifacts.get(new URL(String(url)).pathname.split('/').at(-1)!);
        return artifact ? { status: 200, data: artifact } : { status: 404, data: { error: 'not_found' } };
      }
      throw new Error(`Unexpected HTTP GET: ${String(url)}`);
    });
    const post = vi.spyOn(axios, 'post').mockImplementation(async (url, raw: unknown) => {
      if (new URL(String(url)).pathname === `/v1/actions/${actionId}/execution-authorization/verify`) return policy === 'refused by Home'
        ? { status: 403, data: { ok: false } } : { status: 200, data: { ok: true } };
      expect(new URL(String(url)).pathname).toBe('/v1/artifacts');
      if (!raw || typeof raw !== 'object' || !('id' in raw) || !('body' in raw)) throw new Error('Malformed Artifact request');
      const body = typeof raw.body === 'string' ? decodePlainArtifactStoredContent(raw.body) : null;
      if (!body || typeof body !== 'object' || !('body' in body) || typeof body.body !== 'string') throw new Error('Missing private approval body');
      savedApprovals.push(ApprovalRequestV2Schema.parse(JSON.parse(body.body)));
      approvalArtifacts.set(String(raw.id), { ...raw, ownerAccountId: accountId, access: 'owner', encryptionMode: 'plain',
        publicAudience: 'none', dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
        headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 });
      return { status: 200, data: { id: raw.id, headerVersion: 1, bodyVersion: 1 } };
    });
    try {
      const native = createCliActionExecutorFromCredentials({ credentials, machineId: target.machineId,
        serverId: 'profile', serverApiUrl: 'https://home.test', serverIdentityId: 'srv_home',
        externalActionMachineRequestPrivateKey: privateKey, externalActionMachineInstallationId: 'installation',
        managedMachineAction: async request => {
          expect(request.context).toMatchObject({ surface: 'ui', authority, runtimeAccountId: accountId });
          effects++; return { managedId: 'retained' };
        },
      });
      const executor: ExternalActionExecutor = { execute: async (id, args, context) => {
        if (operation === 'execute') return await native.execute(id, args, context);
        const prepared = await native.prepare(id, args, context);
        return prepared.kind === 'settled' ? prepared.result : await prepared.invocation.run();
      } };
      const result = await executeExternalAction({ actionId, envelope, principal, executionAuthorization: authorization,
        currentMachineId: target.machineId, currentServerId: 'profile', currentInstallationId: 'installation', executor,
        externalActionMachineRequestPrivateKey: privateKey,
        verifyExecutionAuthorization: async () => true,
        resolveTarget: createDaemonExternalActionTargetResolver({ credentials }),
      });
      if (policy === 'invalid settings') {
        expect(result, JSON.stringify(result)).toMatchObject({ kind: 'response', response: { execution: {
          ok: false, errorCode: 'ACCOUNT_SETTINGS_CONTENT_INVALID', error: 'ACCOUNT_SETTINGS_CONTENT_INVALID',
        } } });
        expect(effects).toBe(0);
        expect(savedApprovals).toHaveLength(0);
        expect(JSON.stringify(result)).not.toContain('PRIVATE_POLICY_RESPONSE_MUST_NOT_LEAK');
        return;
      }
      if (policy === 'refused by Home') {
        expect(result, JSON.stringify(result)).toMatchObject({ kind: 'response', response: { execution: { ok: false, errorCode: 'target_unavailable' } } });
        expect(effects).toBe(0);
        expect(savedApprovals).toHaveLength(0);
        return;
      }
      if (authority === 'present_user') {
        // A remote UI carrier has no local presenter: the mounted UI owns this review.
        expect(result).toMatchObject({ kind: 'response', response: { execution: {
          ok: false, errorCode: 'action_interactive_review_required',
          details: { review: { actionArgs: input }, reviewDigest: expect.any(String) },
        } } });
        expect(effects).toBe(0);
        expect(savedApprovals).toHaveLength(0);
        return;
      }
      expect(result, JSON.stringify(result)).toMatchObject({ kind: 'response', response: { execution: { ok: true, result: { kind: 'approval_request_created', actionId } } } });
      expect(effects).toBe(0);
      expect(savedApprovals).toHaveLength(1);
      expect(savedApprovals[0]).toMatchObject({ status: 'open', executionOriginV1: { accountId, authority, surface: 'ui' } });
    } finally {
      get.mockRestore(); post.mockRestore(); resetActiveAccountSettingsSnapshotForTests(); vi.unstubAllEnvs();
    }
  });

  it.each([
    ['plain', 'machines.managed.acquire', 'own', 'present_user'], ['e2ee', 'machines.managed.acquire', 'own', 'present_user'],
    ['plain', 'machines.managed.bootstrap.retry', 'own', 'present_user'], ['e2ee', 'machines.managed.bootstrap.retry', 'own', 'present_user'],
    ['plain', 'machines.managed.acquire', 'admitted requester', 'present_user'], ['e2ee', 'machines.managed.acquire', 'admitted requester', 'present_user'],
    ['plain', 'machines.managed.acquire', 'own', 'account_automation'], ['e2ee', 'machines.managed.acquire', 'own', 'account_automation'],
    ['plain', 'machines.managed.acquire', 'admitted requester', 'account_automation'],
    ['e2ee', 'machines.managed.acquire', 'admitted requester', 'account_automation'],
  ] as const)('preserves exact-Account confirmation or deferred human replay for %s %s %s %s', async (mode, actionId, custody, authority) => {
    const accountPrincipal = { accountId: 'requester', authority,
      authentication: { kind: 'account' as const, tokenEpoch: 7 } };
    const target = { kind: 'machine' as const, machineId: 'controller' };
    const guestCli = (sha256: string) => ({ source: 'home-payload' as const, line: '0.3', channel: 'stable' as const,
      payloads: [{ target: { os: 'linux' as const, arch: 'x64' as const }, sha256,
        url: '/v1/runtime/guest-cli/payloads/linux/x64' }] });
    // This matrix tests compute admission/Ask, not guest administrator or
    // isolation setup. A sandbox creation demands neither optional child.
    const input: JsonValue = actionId === 'machines.managed.acquire' ? { enrollmentIdentity: { kind: 'guestProcess', role: 'sandbox' }, selection: { kind: 'one-off' as const,
      homeId: 'srv_home', controller: { machineId: target.machineId, installationId: 'installation' },
      launch: { provider: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: {} },
      retention: { kind: 'until-delete' as const }, wakeOnAcceptedMessage: false,
    } } : { homeId: 'srv_home', managedId: 'retained', expectedIntentRevision: 0, guestCli: guestCli('a'.repeat(64)) };
    const binding = { accountId: accountPrincipal.accountId, authentication: accountPrincipal.authentication,
      serverIdentityId: 'srv_home', actionId, requestId: 'reviewed-request', target };
    const material = { type: 'dataKey' as const, machineKey: new Uint8Array(32).fill(23) };
    const envelope = mode === 'e2ee' ? sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding, material, input,
      randomBytes: length => new Uint8Array(length).fill(12),
      ...(actionId === 'machines.managed.acquire' ? { managedAdmission: {
        actionId: 'machines.managed.acquire' as const, input: ManagedAdmissionComputeInputV1Schema.parse(input), continuationPresent: false,
      } } : {}),
    }) : { v: 1 as const, input, target, requestId: binding.requestId };
    const keyPair = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(8));
    const managedProjection = projectExternalActionManagedAdmissionV1(actionId, input);
    const recoveryAdmission = managedProjection?.actionId === 'machines.managed.bootstrap.retry'
      ? { ...managedProjection, input: { ...managedProjection.input, guestCli: guestCli('b'.repeat(64)) } } : undefined;
    const rawAuthorization = { v: 1 as const, token: 'signed-account-root', binding: { ...binding,
      machineId: target.machineId, custodianAccountId: custody === 'own' ? accountPrincipal.accountId : 'alice', installationId: 'installation',
      requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), accountEncryptionMode: mode,
      ...(recoveryAdmission ? { managedAdmission: recoveryAdmission } : {}),
    } };
    const authorization = custody === 'admitted requester' ? sealManagedControllerActionCodecV1({
      authorization: rawAuthorization, material, installationPublicKey: keyPair.publicKey,
      invocation: { caller: { kind: 'host' }, surface: 'ui', authority }, randomBytes: tweetnacl.randomBytes,
    }) : rawAuthorization;
    const currentness = createDaemonApprovalExecutionOriginCurrentness({ accountId: accountPrincipal.accountId,
      machineId: target.machineId, serverId: 'profile',
      resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: 'srv_home', machineId: target.machineId }),
      resolveTarget: createDaemonExternalActionTargetResolver({ credentials: { token: 'requester', encryption: null } }),
      isAccountCurrent: async () => true,
      listAccountApiTokens: async () => ({ tokens: [] }), externalActionMachinePublicKey: keyPair.publicKey,
      // Current Home proof verification is the network boundary. Installation,
      // original input signature, strict Artifact and Action policy stay real.
      verifyExternalExecutionAuthorization: async () => true,
    });
    const settings = ActionsSettingsV1Schema.parse({ v: 1, ...(authority === 'present_user' ? { actions: {
      [actionId]: { approvalRequiredSurfaces: ['ui'] },
    } } : {}) });
    const artifacts = new Map<string, ApprovalRequest>();
    const states: string[] = [];
    const confirm = vi.fn(async () => true);
    let effects = 0;
    // Persistent Artifact IO is substituted; its immutable subject and
    // open/approved/executing/terminal transition owner remain real.
    const approvalStore = {
      approvalsCreate: async ({ request }: { request: ApprovalRequest }) => {
        const artifactId = `approval-${artifacts.size + 1}`;
        const parsed = ApprovalRequestV2Schema.parse(request);
        artifacts.set(artifactId, parsed); states.push(parsed.status);
        return { artifactId };
      },
      approvalsGet: async ({ artifactId }: { artifactId: string }) => artifacts.get(artifactId) ?? null,
      approvalsUpdate: async ({ artifactId, request }: { artifactId: string; request: ApprovalRequest }) => {
        const previous = artifacts.get(artifactId);
        if (!previous) throw new Error('Missing approval Artifact');
        const next = ApprovalRequestV2Schema.parse(request);
        const admitted = decideApprovalRequestTransition(previous, next);
        if (!admitted.ok) return admitted;
        artifacts.set(artifactId, next); states.push(next.status);
        return { ok: true as const };
      },
    };
    const token = `fixture.${Buffer.from(JSON.stringify({ sub: accountPrincipal.accountId })).toString('base64url')}.signature`;
    const credentials = { token, encryption: mode === 'e2ee' ? { ...material,
      publicKey: tweetnacl.box.keyPair.fromSecretKey(material.machineKey).publicKey } : null };
    const settingsContent = prepareAccountSettingsV2Content({ credentials,
      raw: { actionsSettingsV1: settings }, envelopeKind: mode === 'plain' ? 'plain' : 'encrypted' });
    const installation = vi.spyOn(installationIdentity, 'readInstallationIdentityIfExistsSync').mockReturnValue({ version: 1,
      installationId: 'installation', publicKey: encodeBase64(keyPair.publicKey, 'base64url'),
      privateKey: encodeBase64(keyPair.secretKey, 'base64url'), createdAt: 1 });
    const get = vi.spyOn(axios, 'get').mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/profile') return { status: 200, data: { id: accountPrincipal.accountId } };
      if (path === '/v2/account/settings') return { status: 200, data: { content: settingsContent, version: 1 } };
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode, version: 1,
        signingKeyFingerprint: null, contentKeyFingerprint: credentials.encryption
          ? computeAccountEncryptionMigrateKeyFingerprintV1(credentials.encryption.publicKey) : null, updatedAt: 1 } };
      throw new Error(`Unexpected replay GET ${path}`);
    });
    const post = vi.spyOn(axios, 'post').mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith('/execution-authorization/verify')) return { status: 200, data: { ok: true } };
      throw new Error(`Unexpected replay POST ${path}`);
    });
    onTestFinished(() => { get.mockRestore(); post.mockRestore(); installation.mockRestore(); });
    const prepareApprovalExecutionAuthorization = createDaemonApprovalExecutionAuthorizationPreparer({
      machineId: target.machineId, serverId: 'profile', serverBaseUrl: 'https://home.test',
      resolveCurrentMachineExecutionOriginContext: async () => ({ machineId: target.machineId, serverIdentityId: 'srv_home' }),
      daemonWorkSignal: new AbortController().signal,
      // The fresh deciding Account holds these requester credentials. Match
      // execution.ts's policy reader through real settings HTTP/decryption.
      readAdmittedRequesterActionsSettings: async ({ signal }) => {
        const snapshot = await runWithServerHttpBaseUrl('https://home.test', () =>
          bootstrapAccountSettingsContext({ credentials, signal, mode: 'blocking', publication: 'invocation' }));
        return snapshot.settings.actionsSettingsV1;
      },
      prepareRequesterAccountContext: request => prepareRequesterAccountActionContext({ authorization: request.authorization,
        purpose: { kind: 'external_action' }, machineId: target.machineId, installationId: 'installation',
        installationPrivateKey: keyPair.secretKey, serverId: 'profile', serverIdentityId: 'srv_home',
        serverHttpBaseUrl: 'https://home.test', ownCredentials: credentials, isCurrent: async () => true,
        createExecutor: () => daemon }),
    });
    const daemon: ReturnType<typeof createCliActionExecutorHarness>['executor'] = createCliActionExecutorHarness({ token, credentials: { token, encryption: null }, sessionId: '',
      serverId: 'profile', serverIdentityId: 'srv_home', serverHttpBaseUrl: 'https://home.test', mode: 'plain', ctx: null,
      actionsSettingsProvider: { getActionsSettings: () => settings, getAccountSettings: () => null },
    }, { ...approvalStore, isApprovalExecutionOriginCurrent: currentness,
      prepareApprovalExecutionAuthorization,
      presentUserActionConfirmation: confirm,
      managedMachineAction: async request => {
        expect(request.context).toMatchObject({ authority, actionRequestId: binding.requestId,
          externalActionExecutionAuthorization: authorization, runtimeAccountId: accountPrincipal.accountId });
        if (request.actionId === 'machines.managed.get') return ManagedMachineFullV1Schema.parse({
          id: 'retained', homeId: 'srv_home', custodianAccountId: accountPrincipal.accountId,
          controller: { machineId: target.machineId, installationId: 'installation' },
          launch: { provider: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: {} },
          allocation: 'unsubmitted', creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 0,
          retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
        });
        effects++;
        return { managedId: 'retained' };
      },
    }).executor;
    // The production credentialed executor supplies these host facts on replay;
    // the lower-level harness requires them through its public currentAccount input.
    const replay = daemon.replayApprovedApprovalRequest;
    daemon.replayApprovedApprovalRequest = (args, ingress) => replay({ ...args, currentAccount: {
      accountId: accountPrincipal.accountId, serverId: 'profile', serverIdentityId: 'srv_home', actionsSettings: settings,
    } }, ingress);
    const handlers = new Map<string, (input: unknown, context?: RpcHandlerContext) => Promise<unknown>>();
    registerApprovalRpcHandlers({ rpcHandlerManager: { registerHandler: (method, handler) => { handlers.set(method, handler); } },
      actionExecutor: custody === 'own' ? daemon : createActionExecutor(createUnavailableHostActionDeps()) });
    const freshAdmission = { ...authorization };
    // The already-admitted private host facet is not a wire field. Generic installed-box admission is tested at RpcHandlerManager.
    Object.defineProperty(freshAdmission, 'requesterAccountExecutor', { value: daemon, enumerable: false });
    // Both native acquire and retained bootstrap retry execute on their controller.
    const client = createActionExecutor({ ...createUnavailableHostActionDeps(), ...approvalStore,
      isApprovalExecutionOriginCurrent: currentness,
      approvalRequestApprovedReplay: async request => {
        if (request.request.v !== 2 || resolveApprovalExecutor(request.request).kind !== 'daemon') return null;
        const result = await handlers.get(RPC_METHODS.APPROVAL_REQUEST_REPLAY_APPROVED)!({ artifactId: request.artifactId },
          { callerAuthority: 'present_user', signal: new AbortController().signal,
            ...(custody === 'admitted requester' ? { callerInputAuthorization: freshAdmission } : {}) });
        return projectExternalActionExecutionResultV1(result);
      },
      managedMachineAction: async () => { throw new Error('Controller approval must not execute in the app'); },
    });
    const execute = (root = authorization) => executeExternalAction({ actionId, envelope, principal: accountPrincipal,
      currentMachineId: target.machineId, currentServerId: 'profile', currentInstallationId: 'installation',
      executionAuthorization: root, externalActionMachineRequestPrivateKey: keyPair.secretKey,
      verifyExecutionAuthorization: async () => true,
      resolveEncryption: async () => ({ serverIdentityId: 'srv_home', material }),
      resolveTarget: createDaemonExternalActionTargetResolver({ credentials: { token: 'requester', encryption: null } }), executor: daemon,
    });
    if (recoveryAdmission) {
      expect(await execute({ ...authorization, binding: { ...authorization.binding,
        managedAdmission: { ...recoveryAdmission, input: { ...recoveryAdmission.input, managedId: 'unrelated-resource' } } } }))
        .toMatchObject({ kind: 'invalid_request', errorCode: mode === 'e2ee' ? 'invalid_encrypted_envelope' : 'invalid_envelope' });
      expect(artifacts.size).toBe(0);
      expect(effects).toBe(0);
    }
    if (custody === 'admitted requester' && authority === 'account_automation') {
      // A controller codec is not an Account credential box: wrong receivers
      // and a changed signed root must remain closed before replay effects.
      const wrongReceiver = sealManagedControllerActionCodecV1({ authorization: rawAuthorization, material,
        installationPublicKey: tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(24)).publicKey,
        randomBytes: tweetnacl.randomBytes });
      for (const rejected of [wrongReceiver, { ...authorization,
        binding: { ...authorization.binding, requestId: 'changed-root' } }]) {
        expect(await prepareApprovalExecutionAuthorization({ authorization: rejected })).toBeNull();
      }
      expect(effects).toBe(0);
    }
    const admitted = await execute();
    const result = admitted.kind === 'response' ? admitted.response.v === 2 && envelope.v === 2
      ? openExternalActionResponseV2({ envelope: admitted.response, binding, material, request: envelope })
      : admitted.response.v === 1 ? admitted.response.execution : null : null;
    if (authority === 'present_user') {
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { managedId: 'retained' } });
      expect(confirm).toHaveBeenCalledOnce();
      expect(artifacts.size).toBe(0);
      expect(effects).toBe(1);
      return;
    }
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { kind: 'approval_request_created', artifactId: 'approval-1', actionId } });
    expect(effects).toBe(0);
    const approval = ApprovalRequestV2Schema.parse(artifacts.get('approval-1'));
    expect(approval.executionOriginV1).toMatchObject({ authority, surface: 'ui', caller: { kind: 'host' },
      accountId: accountPrincipal.accountId, machineId: target.machineId, requestId: binding.requestId });
    expect(resolveApprovalExecutor(approval)).toEqual({ kind: 'daemon', machineId: target.machineId });
    expect(await client.execute('approval.request.decide', { artifactId: 'approval-1', decision: 'approve' },
      { surface: 'voice', authority: 'account_automation', serverId: 'profile' }))
      .toMatchObject({ ok: false, errorCode: 'present_user_required' });
    expect(artifacts.get('approval-1')?.status).toBe('open');
    expect(effects).toBe(0);
    const decision = await client.execute('approval.request.decide', { artifactId: 'approval-1', decision: 'approve' },
      { surface: 'ui', authority: 'present_user', serverId: 'profile', serverIdentityId: 'srv_home',
        runtimeAccountId: accountPrincipal.accountId });
    expect(decision, JSON.stringify(decision)).toMatchObject({ ok: true, result: { status: 'executed', execution: { ok: true, result: { managedId: 'retained' } } } });
    expect(states).toEqual(['open', 'approved', 'executing', 'executed']);
    expect(artifacts.size).toBe(1);
    expect(effects).toBe(1);
    const repeated = actionId === 'machines.managed.bootstrap.retry'
      ? await client.replayApprovedApprovalRequest({ artifactId: 'approval-1', callerAuthority: 'present_user',
        currentAccount: { accountId: accountPrincipal.accountId, serverId: 'profile', serverIdentityId: 'srv_home' } })
      : await handlers.get(RPC_METHODS.APPROVAL_REQUEST_REPLAY_APPROVED)!({ artifactId: 'approval-1' },
        { callerAuthority: 'present_user', signal: new AbortController().signal,
          ...(custody === 'admitted requester' ? { callerInputAuthorization: freshAdmission } : {}) });
    expect(repeated).toEqual(decision);
    expect(effects).toBe(1);
  });

  // Owner decision 2026-11-07 N1: a terminal bearer cannot claim the UI approval floor.
  it.each([
    ['terminal', 'cli'],
    ['account', 'ui'],
  ] as const)('resolves a UI claim from %s authentication to %s at Account ingress', async (kind, expectedSurface) => {
    const accountPrincipal = { accountId: 'requester', authority: 'account_automation' as const,
      authentication: { kind, tokenEpoch: 7 } };
    const target = { kind: 'machine' as const, machineId: 'controller' };
    const envelope = { v: 1 as const, requestId: 'surface-claim', target, input: { homeId: 'srv_home' } };
    let servedContext: ActionExecutorContext | undefined;
    // Managed HTTP output and Home proof verification are network boundaries.
    const managedMachineAction = async ({ context }: { context: ActionExecutorContext }) => {
      servedContext = context;
      return { machines: [] };
    };
    const result = await executeExternalAction({
      actionId: 'machines.managed.list', envelope, principal: accountPrincipal, surface: 'ui',
      currentMachineId: target.machineId, currentServerId: 'profile', currentInstallationId: 'installation',
      executionAuthorization: { v: 1, token: 'home-signed-root', binding: {
        accountId: accountPrincipal.accountId, authentication: accountPrincipal.authentication,
        serverIdentityId: 'srv_home', machineId: target.machineId, custodianAccountId: 'requester', installationId: 'installation',
        actionId: 'machines.managed.list', requestId: envelope.requestId, target,
        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), accountEncryptionMode: 'plain',
      } },
      externalActionMachineRequestPrivateKey: tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(8)).secretKey,
      verifyExecutionAuthorization: async () => true,
      resolveTarget: createDaemonExternalActionTargetResolver({ credentials: { token: 'requester', encryption: null } }),
      executor: createActionExecutor({ ...createUnavailableHostActionDeps(), managedMachineAction }),
    });
    expect(result).toMatchObject({ kind: 'response', response: { execution: { ok: true } } });
    expect(servedContext).toMatchObject({ surface: expectedSurface, authority: 'account_automation' });
  });

  it.each(['owner', 'unknown', 'other_account', 'other_home', 'terminal'] as const)('admits only a qualified own-Account host cause at the real receiver (%s)', async scenario => {
    const authentication = { kind: scenario === 'terminal' ? 'terminal' as const : 'account' as const, tokenEpoch: 7 };
    const principal = { accountId: 'requester', authority: 'account_automation' as const, authentication };
    const target = { kind: 'machine' as const, machineId: 'controller' };
    const envelope = { v: 1 as const, requestId: 'qualified-host-cause', target, input: { homeId: 'srv_home' } };
    const cause = { requestRef: 'original-input', requester: scenario === 'unknown' ? null : {
      accountId: scenario === 'other_account' ? 'other-person' : 'requester',
      serverId: scenario === 'other_home' ? 'srv_other_home' : 'srv_home',
    }, persona: { serverId: 'srv_home', sessionId: 'original-session' }, origin: null };
    let servedContext: ActionExecutorContext | undefined;
    const result = await executeExternalAction({ actionId: 'machines.managed.list', envelope, principal,
      localRootInvocation: { caller: { kind: 'host' }, surface: 'mcp', authority: 'account_automation', actionRequestAttributionV1: cause },
      currentMachineId: target.machineId, currentServerId: 'profile', currentInstallationId: 'installation',
      executionAuthorization: { v: 1, token: 'home-signed-root', binding: {
        accountId: principal.accountId, authentication, serverIdentityId: 'srv_home', machineId: target.machineId,
        custodianAccountId: 'requester', installationId: 'installation', actionId: 'machines.managed.list',
        requestId: envelope.requestId, target, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), accountEncryptionMode: 'plain',
      } },
      externalActionMachineRequestPrivateKey: tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(8)).secretKey,
      verifyExecutionAuthorization: async () => true,
      resolveTarget: createDaemonExternalActionTargetResolver({ credentials: { token: 'requester', encryption: null } }),
      executor: createActionExecutor({ ...createUnavailableHostActionDeps(), managedMachineAction: async ({ context }) => {
        servedContext = context; return { machines: [] };
      } }),
    });
    if (scenario === 'owner' || scenario === 'unknown') {
      expect(result).toMatchObject({ kind: 'response', response: { execution: { ok: true } } });
      expect(servedContext).toMatchObject({ actionRequestAttributionV1: cause, authority: 'account_automation' });
    } else {
      expect(result).toMatchObject({ kind: 'response', response: { execution: { ok: false, errorCode: 'forbidden' } } });
      expect(servedContext).toBeUndefined();
    }
  });

  it.each(['account', 'unknown'] as const)('materializes only the exact signed Session caller and %s cause instead of promoting it to a present user', async requester => {
    const cause = deriveSessionInputActionRequestAttributionV1({ requestRef: 'original-input',
      persona: { serverId: 'srv_home', sessionId: 'source' }, messageRole: 'user', origin: null,
      inputAdmissionReceipt: requester === 'account'
        ? { v: 1, issuer: 'authenticatedAccount', actorAccountId: 'requester', sessionRelationship: 'owner' }
        : { v: 1, issuer: 'authenticatedMachine' } });
    if (!cause) throw new Error('Expected a receipt-derived Session input cause');
    const sessionActionOrigin = SessionActionRpcOriginV1Schema.parse(JSON.parse(JSON.stringify(resolveSessionRoleRpcOrigin({
      actionCaller: { kind: 'session', sessionId: 'source', starterDepth: 1, turnDepth: 2 },
      sessionInputSource: { sourceSessionId: 'source', sourceTurnId: 'turn', sourceInputId: 'original-input' },
      actionRequestAttributionV1: cause, callerPermissionMode: 'read-only',
      causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'read-only' },
      workspaceWrites: 'deny', actionRequestId: 'original-request',
    }))));
    const accountPrincipal = { accountId: 'requester', authority: 'account_automation' as const,
      authentication: { kind: 'account' as const, tokenEpoch: 7 }, sessionActionOrigin };
    const target = { kind: 'machine' as const, machineId: 'controller' };
    const envelope = { v: 1 as const, requestId: 'original-request', target, input: { homeId: 'srv_home' } };
    const authorization = { v: 1 as const, token: 'home-signed-source', binding: {
      accountId: accountPrincipal.accountId, authentication: accountPrincipal.authentication, sessionActionOrigin,
      sessionActionSource: { machineId: 'source-machine', installationId: 'source-installation' },
      serverIdentityId: 'srv_home', machineId: target.machineId, custodianAccountId: 'requester', installationId: 'installation',
      actionId: 'machines.managed.list', requestId: envelope.requestId, target,
      requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), accountEncryptionMode: 'plain' as const,
    } };
    let servedContext: ActionExecutorContext | undefined;
    // Managed HTTP and Home proof currentness are network boundaries; the
    // receiving transport, target reconciliation and Action executor stay real.
    const managedMachineAction = vi.fn(async ({ context }: { context: ActionExecutorContext }) => {
      servedContext = context;
      return { machines: [] };
    });
    const run = (requestPrincipal: typeof accountPrincipal) => executeExternalAction({
      actionId: 'machines.managed.list', envelope, principal: requestPrincipal, surface: 'ui',
      currentMachineId: target.machineId, currentServerId: 'profile', currentInstallationId: 'installation',
      executionAuthorization: authorization,
      externalActionMachineRequestPrivateKey: tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(8)).secretKey,
      verifyExecutionAuthorization: async () => true,
      resolveTarget: createDaemonExternalActionTargetResolver({ credentials: { token: 'requester', encryption: null } }),
      executor: createActionExecutor({ ...createUnavailableHostActionDeps(), managedMachineAction }),
    });
    expect(await run(accountPrincipal)).toMatchObject({ kind: 'response', response: { execution: { ok: true } } });
    expect(servedContext).toMatchObject({ surface: 'agent', authority: 'account_automation',
      actionCaller: sessionActionOrigin.caller, defaultSessionId: 'source', callerPermissionMode: 'read-only', workspaceWrites: 'deny',
      actionRequestAttributionV1: cause,
      causalPermissionAuthority: sessionActionOrigin.causalPermissionAuthority,
      sessionInputSource: { sourceSessionId: 'source', sourceTurnId: 'turn', sourceInputId: 'original-input', via: 'action' } });
    expect(servedContext).not.toHaveProperty('externalActionCredential');
    expect(await run({ ...accountPrincipal, sessionActionOrigin: { ...sessionActionOrigin,
      caller: { ...sessionActionOrigin.caller, turnDepth: 0 } } })).toMatchObject({ kind: 'invalid_request', errorCode: 'invalid_envelope' });
    expect(await run({ ...accountPrincipal, sessionActionOrigin: { ...sessionActionOrigin,
      actionRequestAttributionV1: { ...cause, requester: { serverId: 'srv_home', accountId: 'substituted-person' } },
    } })).toMatchObject({ kind: 'invalid_request', errorCode: 'invalid_envelope' });
    expect(managedMachineAction).toHaveBeenCalledTimes(1);
  });
  it('admits ordinary Account proof without PAT grants and rejects changed pre-forward compute before any effect', async () => {
    const accountPrincipal = { accountId: 'requester', authority: 'present_user' as const,
      authentication: { kind: 'account' as const, tokenEpoch: 7 } };
    const target = { kind: 'machine' as const, machineId: 'machine-1' };
    const material = { type: 'dataKey' as const, machineKey: new Uint8Array(32).fill(23) };
    const privateKey = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(8)).secretKey;
    let servedContext: ActionExecutorContext | undefined;
    // Managed HTTP output and Home currentness are network boundaries; the
    // receiver, target owner, crypto and canonical Action executor stay real.
    const managedMachineAction = vi.fn(async ({ context }: { context: ActionExecutorContext }) => {
      servedContext = context;
      return { machines: [] };
    });
    const executor = createActionExecutor({ ...createUnavailableHostActionDeps(), managedMachineAction });
    const run = async (actionId: 'machines.managed.list' | 'machines.managed.acquire', actionInput: unknown,
      projection?: Parameters<typeof executeExternalAction>[0]['envelope']) => {
      const envelope = { ...sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding: { accountId: accountPrincipal.accountId,
        authentication: accountPrincipal.authentication, serverIdentityId: 'srv_home', actionId, requestId: 'ordinary', target },
        input: actionInput, material, randomBytes: length => new Uint8Array(length).fill(12) }),
        ...(projection && typeof projection === 'object' ? projection : {}),
      };
      return await executeExternalAction({ actionId, envelope, principal: accountPrincipal,
        currentMachineId: target.machineId, currentServerId: 'profile', currentInstallationId: 'installation-1',
        executionAuthorization: { v: 1, token: 'signed-account-root', binding: {
          accountId: accountPrincipal.accountId, authentication: accountPrincipal.authentication, serverIdentityId: 'srv_home',
          machineId: target.machineId, custodianAccountId: 'custodian', installationId: 'installation-1',
          actionId, requestId: 'ordinary', target, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
        } },
        externalActionMachineRequestPrivateKey: privateKey, verifyExecutionAuthorization: async () => true,
        resolveEncryption: async () => ({ serverIdentityId: 'srv_home', material }),
        resolveTarget: createDaemonExternalActionTargetResolver({ credentials: { token: 'custodian', encryption: null } }), executor,
      });
    };
    expect(await run('machines.managed.list', { homeId: 'home' })).toMatchObject({ kind: 'response' });
    expect(servedContext).toMatchObject({ authority: 'present_user', serverId: 'profile', serverIdentityId: 'srv_home',
      externalActionExecutionAuthorization: {
      binding: { accountId: 'requester', authentication: accountPrincipal.authentication },
    } });
    expect(servedContext).not.toHaveProperty('externalActionCredential');
    const compute = { enrollmentIdentity, selection: { kind: 'one-off' as const, homeId: 'home',
      controller: { machineId: target.machineId, installationId: 'installation-1' },
      launch: { provider: { pluginId: 'machine.example', localId: 'vm' }, schemaVersion: 1, name: 'VM', choices: {} },
      retention: { kind: 'until-delete' as const }, wakeOnAcceptedMessage: false } };
    expect(await run('machines.managed.acquire', compute, { managedAdmission: {
      actionId: 'machines.managed.acquire', input: { ...compute, selection: { ...compute.selection, wakeOnAcceptedMessage: true } },
      continuationPresent: false,
    } })).toMatchObject({ kind: 'invalid_request', errorCode: 'invalid_encrypted_envelope' });
    expect(managedMachineAction).toHaveBeenCalledTimes(1);
  });
  it('preserves admitted requester private Account ports through wire parsing and refuses their retired custody', async () => {
    const target = { kind: 'machine' as const, machineId: 'machine-1' };
    const envelope = { v: 1 as const, requestId: 'requester-ports', target, input: { message: 'Finished' } };
    const secret = new Uint8Array(32).fill(7);
    const key = { kind: 'project-organization', serverId: 'home-profile', projectKey: 'bob-project' } as const;
    const row = createProjectAccountRowCipherV1({ mode: 'e2ee', material: { type: 'legacy', secret },
      randomBytes: length => new Uint8Array(length).fill(12) }).seal({ key, value: { pinned: true } });
    const read = vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: {
      mode: 'e2ee', version: 1, signingKeyFingerprint: 'signing', contentKeyFingerprint: 'content', updatedAt: 1,
    } });
    try {
      let live = true;
      const authorization = await projectRequesterAccountActionAuthorization({
        authorization: { v: 1, token: 'home-proof', binding: { accountId: principal.accountId,
          principalId: principal.principalId, credentialId: principal.credentialId, grant: principal.grant,
          serverIdentityId: 'home', custodianAccountId: 'alice', machineId: target.machineId,
          installationId: 'installation-1', actionId: 'notifications.notify_me', requestId: envelope.requestId,
          target, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) } },
        serverIdentityId: 'home', bootstrap: { credentials: { token: 'bob-ordinary', encryption: { type: 'legacy', secret } },
          attribution: { serverId: 'home-profile', accountId: principal.accountId, machineId: target.machineId,
            installationId: 'installation-1' }, serverHttpBaseUrl: 'https://bob-home.test', isCurrent: async () => live },
      });
      if (!authorization) throw new Error('Expected admitted private requester projection');
      // Notification delivery is the network boundary; all Action/crypto/admission owners are real.
      const deliver = vi.fn(async (_input: unknown, context: ActionExecutorContext) => {
        const projection = context.externalActionExecutionAuthorization?.requesterAccountProjection;
        const opened = projection?.projectAccountRowCipher.open(key, row);
        return { attemptedChannels: 1, deliveredChannels: opened?.value && 'pinned' in opened.value && opened.value.pinned ? 1 : 0 };
      });
      const run = () => executeExternalAction({ actionId: 'notifications.notify_me', envelope, principal,
        currentMachineId: target.machineId, currentServerId: 'home-profile', currentInstallationId: 'installation-1',
        executionAuthorization: authorization,
        externalActionMachineRequestPrivateKey: tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(8)).secretKey,
        verifyExecutionAuthorization: async () => true,
        resolveTarget: createDaemonExternalActionTargetResolver({ credentials: { token: 'alice', encryption: null } }),
        executor: createActionExecutor({ ...createUnavailableHostActionDeps(), notificationsNotifyMe: deliver }),
      });
      expect(await run()).toMatchObject({ kind: 'response', response: { execution: {
        ok: true, result: { attemptedChannels: 1, deliveredChannels: 1 },
      } } });
      live = false;
      expect(await run()).toMatchObject({ kind: 'response', response: { execution: { ok: false, errorCode: 'not_authenticated' } } });
      expect(deliver).toHaveBeenCalledTimes(1);
    } finally { read.mockRestore(); }
  });

  it('opens shared Machine V2 under target material and rechecks current admission after preparation', async () => {
    const target = { kind: 'machine' as const, machineId: 'machine-1' };
    const machineMaterial = { type: 'dataKey' as const, machineKey: new Uint8Array(32).fill(23) };
    const actorMaterial = { type: 'dataKey' as const, machineKey: new Uint8Array(32).fill(17) };
    const installationId = '11111111-1111-4111-8111-111111111111';
    const binding = { serverIdentityId: 'srv_home', accountId: 'bob',
      credentialId: '00000000-0000-4000-8000-000000000001', actionId: 'session.spawn_new',
      requestId: 'shared-machine-start', target };
    const envelope = sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding, material: machineMaterial,
      input: { creationKey: 'shared-start', agentTarget: { kind: 'agent',
        identity: { pluginId: 'happier.agent.codex', localId: 'codex' } }, directory: { kind: 'managed' } },
      randomBytes: (length) => new Uint8Array(length).fill(2) });
    const authorization = { v: 1 as const, token: 'home-proof', binding: {
      ...binding, principalId: 'bob', custodianAccountId: 'alice', installationId,
      machineId: target.machineId, grant: API_TOKEN_FULL_GRANT_V1,
      requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
    } };
    // Host launch is the OS effect boundary; all ingress, crypto, target and Action logic are real.
    const sessionSpawnNew = vi.fn(async () => SESSION_SPAWN_PENDING_RESULT);
    const executor = createActionExecutor({ ...createUnavailableHostActionDeps(), sessionSpawnNew });
    let current = true;
    const run = (material = machineMaterial) => executeExternalAction({
      actionId: binding.actionId, envelope,
      principal: { ...principal, accountId: 'bob', principalId: 'bob', credentialId: binding.credentialId },
      currentMachineId: target.machineId, currentInstallationId: installationId, currentServerId: 'home-profile',
      executionAuthorization: authorization,
      externalActionMachineRequestPrivateKey: tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7)).secretKey,
      resolveEncryption: async () => ({ serverIdentityId: binding.serverIdentityId, material }),
      resolveTarget: createDaemonExternalActionTargetResolver({ credentials: { token: 'alice-daemon-token', encryption: null } }),
      verifyExecutionAuthorization: async () => current,
      executor,
    });
    const successful = await run();
    if (successful.kind !== 'response' || successful.response.v !== 2) throw new Error('Expected protected response');
    expect(openExternalActionResponseV2({ envelope: successful.response, binding, material: machineMaterial, request: envelope }))
      .toMatchObject({ ok: true });
    expect(await run(actorMaterial)).toMatchObject({ kind: 'invalid_request', errorCode: 'invalid_encrypted_envelope' });
    current = false;
    const denied = await run();
    if (denied.kind !== 'response' || denied.response.v !== 2) throw new Error('Expected protected refusal');
    expect(openExternalActionResponseV2({ envelope: denied.response, binding, material: machineMaterial, request: envelope }))
      .toMatchObject({ ok: false, errorCode: 'not_authenticated' });
    expect(sessionSpawnNew).toHaveBeenCalledTimes(1);
  });

  it('spends one Home verification at signed admission; effects consume local cancel until the next request', async () => {
    const target = { kind: 'machine' as const, machineId: 'machine-1' };
    const material = { type: 'dataKey' as const, machineKey: new Uint8Array(32).fill(23) };
    const installationId = '11111111-1111-4111-8111-111111111111';
    const binding = { serverIdentityId: 'srv_home', accountId: 'bob',
      credentialId: '00000000-0000-4000-8000-000000000001', actionId: 'session.spawn_new',
      requestId: 'one-admission', target };
    const envelope = sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding, material,
      input: { creationKey: 'one-admission', agentTarget: { kind: 'agent',
        identity: { pluginId: 'happier.agent.codex', localId: 'codex' } }, directory: { kind: 'managed' } },
      randomBytes: (length) => new Uint8Array(length).fill(2) });
    const authorization = { v: 1 as const, token: 'home-proof', binding: {
      ...binding, principalId: 'bob', custodianAccountId: 'alice', installationId,
      machineId: target.machineId, grant: API_TOKEN_FULL_GRANT_V1,
      requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
    } };
    // Home HTTP and the Action effect are the boundaries; ingress and its ports are real.
    const homePost = vi.spyOn(axios, 'post').mockRejectedValue(new Error('No mid-operation Home currentness POST'));
    let homeCurrent = true;
    let installationCurrent = true;
    const verifyExecutionAuthorization = vi.fn(async () => homeCurrent);
    let effectPorts: ReadonlyArray<() => Promise<boolean>> = [];
    const executor = { execute: async (_actionId: string, _input: unknown, context: RpcActionExecutorContext) => {
      effectPorts = [context.verifyMachineAdmissionCurrent!, context.verifiedExternalActionRequester!.isCurrent,
        context.externalActionExecutionAuthorization!.requesterHttpProjection!.isCurrent];
      // Withdrawal during finite work: admitted work finishes, the next request refuses.
      homeCurrent = false;
      expect(await Promise.all(effectPorts.flatMap(port => [port(), port(), port()]))).toEqual(Array(9).fill(true));
      return { ok: true as const, result: { accepted: true } };
    } } as unknown as Parameters<typeof executeExternalAction>[0]['executor'];
    const controller = new AbortController();
    const run = () => executeExternalAction({ actionId: binding.actionId, envelope,
      principal: { ...principal, accountId: 'bob', principalId: 'bob', credentialId: binding.credentialId },
      currentMachineId: target.machineId, currentInstallationId: installationId, currentServerId: 'home-profile',
      currentServerHttpBaseUrl: 'https://home.test', isInstallationCurrent: () => installationCurrent,
      executionAuthorization: authorization, signal: controller.signal,
      externalActionMachineRequestPrivateKey: tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7)).secretKey,
      resolveEncryption: async () => ({ serverIdentityId: binding.serverIdentityId, material }),
      resolveTarget: createDaemonExternalActionTargetResolver({ credentials: { token: 'alice-daemon-token', encryption: null } }),
      verifyExecutionAuthorization, executor });
    try {
      expect(await run()).toMatchObject({ kind: 'response' });
      expect(verifyExecutionAuthorization).toHaveBeenCalledTimes(1);
      expect(homePost).not.toHaveBeenCalled();
      installationCurrent = false;
      expect(await Promise.all(effectPorts.map(port => port()))).toEqual([false, false, false]);
      installationCurrent = true;
      controller.abort();
      expect(await Promise.all(effectPorts.map(port => port()))).toEqual([false, false, false]);
    } finally { homePost.mockRestore(); }
    const next = await executeExternalAction({ actionId: binding.actionId, envelope,
      principal: { ...principal, accountId: 'bob', principalId: 'bob', credentialId: binding.credentialId },
      currentMachineId: target.machineId, currentInstallationId: installationId, currentServerId: 'home-profile',
      executionAuthorization: authorization,
      externalActionMachineRequestPrivateKey: tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7)).secretKey,
      resolveEncryption: async () => ({ serverIdentityId: binding.serverIdentityId, material }),
      resolveTarget: createDaemonExternalActionTargetResolver({ credentials: { token: 'alice-daemon-token', encryption: null } }),
      verifyExecutionAuthorization, executor });
    expect(verifyExecutionAuthorization).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(next)).not.toContain('accepted');
  });

  it('admits a Companion widget client Action through an exact Session envelope', async () => {
    const target = { kind: 'session' as const, sessionId: 'session-1' };
    const ref = { surface: { serverId: 'home', accountId: principal.accountId,
      owner: { kind: 'companion' as const, sessionId: target.sessionId } }, instanceId: 'checks' };
    // Only the connected-client transport is replaced; ingress and Action admission are real.
    const clientActionExecute = vi.fn(async () => ({ ok: true as const, result: { ref, bindings: {} } }));
    const result = await executeExternalAction({ actionId: 'widgets.item.inputs.get',
      envelope: { v: 1, target, input: { ref } }, principal, currentMachineId: 'machine-1',
      resolveTarget: async ({ target: resolved }) => resolved ?? null,
      executor: createActionExecutor({ ...createUnavailableHostActionDeps(), clientActionExecute }),
    });
    expect(result).toMatchObject({ kind: 'response', response: { execution: { ok: true, result: { bindings: {} } } } });
    expect(clientActionExecute).toHaveBeenCalledWith(expect.objectContaining({
      actionId: 'widgets.item.inputs.get', input: { ref }, context: expect.objectContaining({ defaultSessionId: target.sessionId }),
    }));
  });

  it('uses the current signed grant instead of a wider cached PAT grant', async () => {
    const material = { type: 'dataKey' as const, machineKey: new Uint8Array(32).fill(9) };
    const binding = { serverIdentityId: 'srv_test', accountId: principal.accountId,
      credentialId: '00000000-0000-4000-8000-000000000001', actionId: 'session.permission_mode.set',
      requestId: 'narrowed-send', target: { kind: 'session' as const, sessionId: 'session-1' } };
    const envelope = sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding, material,
      input: { sessionId: 'session-1', permissionMode: 'yolo' },
      randomBytes: (length) => new Uint8Array(length).fill(2) });
    const authorization = { v: 1 as const, token: 'current-home-proof', binding: {
      ...binding, principalId: principal.principalId, machineId: 'machine-1',
      custodianAccountId: principal.accountId, installationId: 'installation-1',
      requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
      grant: { ...API_TOKEN_FULL_GRANT_V1, permissionModes: ['default'] as ['default'] },
    } };
    const sessionPermissionModeSet = vi.fn(async () => ({ ok: true }));
    const result = await executeExternalAction({ actionId: binding.actionId, envelope,
      principal: { ...principal, credentialId: binding.credentialId },
      executionAuthorization: authorization,
      externalActionMachineRequestPrivateKey: tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7)).secretKey,
      currentMachineId: 'machine-1', currentServerId: 'server-1',
      currentInstallationId: 'installation-1', verifyExecutionAuthorization: async () => true,
      resolveEncryption: async () => ({ serverIdentityId: binding.serverIdentityId, material }),
      resolveTarget: async () => binding.target,
      executor: createActionExecutor({ ...createUnavailableHostActionDeps(), sessionPermissionModeSet }),
    });
    if (result.kind !== 'response' || result.response.v !== 2) throw new Error('Expected protected response');
    expect(openExternalActionResponseV2({ envelope: result.response, binding, material, request: envelope }))
      .toMatchObject({ ok: false, errorCode: 'permission_mode_not_granted' });
    expect(sessionPermissionModeSet).not.toHaveBeenCalled();
  });

  it('checks bound creation against decrypted V2 fields before host launch', async () => {
    const material = { type: 'dataKey' as const, machineKey: new Uint8Array(32).fill(9) };
    const agentTarget = { kind: 'agent' as const, identity: { pluginId: 'happier.agent.codex', localId: 'codex' } };
    const placement = { folderId: 'leads', tagIds: ['inbound'] };
    const publicPlacement = { sectionId: placement.folderId, tagIds: placement.tagIds };
    const grant = { ...API_TOKEN_FULL_GRANT_V1, actions: { families: [], ids: ['session.spawn_new'] },
      targets: { sessions: ['existing-only'], machines: [] },
      create: { machineId: 'machine-1', agentTargetKey: buildBackendTargetKeyV2(agentTarget), directory: 'managed' as const, placement } };
    const binding = { serverIdentityId: 'srv_test', accountId: principal.accountId,
      credentialId: '00000000-0000-4000-8000-000000000001', actionId: 'session.spawn_new',
      requestId: 'bound-create', target: { kind: 'machine' as const, machineId: 'machine-1' } };
    const sessionSpawnNew = vi.fn(async () => SESSION_SPAWN_PENDING_RESULT);
    const executor = createActionExecutor({ ...createUnavailableHostActionDeps(), sessionSpawnNew });
    const run = async (directory: unknown) => {
      const envelope = sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding, material, input: {
        creationKey: 'create-bound',
        agentTarget, directory, organizationPlacement: publicPlacement,
      }, randomBytes: (length) => new Uint8Array(length).fill(2) });
      const result = await executeExternalAction({ actionId: binding.actionId, envelope,
        principal: { ...principal, credentialId: binding.credentialId, grant },
        currentMachineId: 'machine-1', currentServerId: 'server-1',
        resolveEncryption: async () => ({ serverIdentityId: binding.serverIdentityId, material }),
        resolveTarget: async () => binding.target, executor });
      if (result.kind !== 'response' || result.response.v !== 2) throw new Error('Expected protected response');
      return openExternalActionResponseV2({ envelope: result.response, binding, material, request: envelope });
    };
    expect(await run({ kind: 'path', path: '/ungranted' })).toMatchObject({
      ok: false, errorCode: 'credential_scope_denied',
    });
    expect(sessionSpawnNew).not.toHaveBeenCalled();
    expect(await run({ kind: 'managed' })).toMatchObject({ ok: true });
    expect(sessionSpawnNew).toHaveBeenCalledOnce();
    expect(sessionSpawnNew).toHaveBeenCalledWith(expect.objectContaining({
      organizationPlacement: placement,
      admittedInput: expect.objectContaining({ organizationPlacement: placement }),
    }));
  });

  it('admits a present-user signed-root handoff on its UI surface', async () => {
    const sessionHandoffStart = vi.fn(async () => ({
      handoffId: 'handoff-1',
      status: {
        handoffId: 'handoff-1',
        status: 'pending' as const,
        phase: 'preparing' as const,
        recoveryActions: [],
      },
      workspace: { kind: 'none' as const },
    }));
    const executor = createActionExecutor({
      ...createUnavailableHostActionDeps(),
      sessionHandoffStart,
      sessionHandoffTargetReplacementApprovalPreflight: vi.fn(async () => ({ type: 'not_required' as const })),
      resolveServerIdForSessionId: vi.fn(() => 'server-1'),
    });

    await expect(executeExternalAction({
      actionId: 'session.handoff',
      envelope: {
        v: 1,
        target: { kind: 'session', sessionId: 'session-1' },
        input: { sessionId: 'session-1', targetMachineId: 'machine-2' },
      },
      principal: { authority: 'present_user' },
      currentMachineId: 'machine-1',
      currentServerId: 'server-1',
      resolveTarget: async ({ target }) => target ?? null,
      executor,
    })).resolves.toMatchObject({
      kind: 'response',
      response: { execution: { ok: true } },
    });
    expect(sessionHandoffStart).toHaveBeenCalledTimes(1);
  });

  it('admits present-user signed-root Actions while keeping them outside PAT admission', async () => {
    const execute = vi.fn<ExternalActionExecutor['execute']>(async () => ({
      ok: true,
      result: { decided: true },
    }));
    const request = {
      actionId: 'approval.request.decide',
      envelope: {
        v: 1 as const,
        input: { artifactId: 'approval-1', decision: 'approve' },
      },
      currentMachineId: 'machine-1',
      resolveTarget: async () => ({ kind: 'machine' as const, machineId: 'machine-1' }),
      executor: { execute },
    };

    await expect(executeExternalAction({
      ...request,
      principal: { authority: 'present_user' },
    })).resolves.toMatchObject({
      kind: 'response',
      response: { execution: { ok: true, result: { decided: true } } },
    });
    expect(execute).toHaveBeenCalledWith(
      'approval.request.decide',
      request.envelope.input,
      expect.objectContaining({ surface: 'ui', authority: 'present_user' }),
    );

    execute.mockClear();
    // Decision Actions are public, but their canonical actor boundary still
    // rejects this automatic PAT before any approval effect.
    await expect(executeExternalAction({ ...request, principal,
      executor: createActionExecutor(createUnavailableHostActionDeps()),
    })).resolves.toMatchObject({ kind: 'response', response: { execution: {
      ok: false, errorCode: 'present_user_required',
    } } });
    expect(execute).not.toHaveBeenCalled();
  });

  it('keeps Session-bound approval observation and decisions target-constrained through daemon ingress', async () => {
    const artifacts = new Map(['session-1', 'session-2'].map(sessionId => [sessionId, ApprovalRequestV2Schema.parse({
      v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
      createdBy: { surface: 'agent', sessionId }, requestedSurface: 'agent',
      actionId: 'session.title.set', actionArgs: { sessionId, title: 'Reviewed title' }, summary: 'Rename Session',
      executionOriginV1: { v: 1, authority: 'account_automation', surface: 'agent',
        caller: { kind: 'session', sessionId, starterDepth: 0, turnDepth: 0 },
        actionId: 'session.title.set', accountId: 'account-1', serverId: 'server-1', sessionId,
        requestId: `rename-${sessionId}` },
    })]));
    const read = async (artifactId: string) => {
      const request = artifacts.get(artifactId);
      return request ? { header: buildApprovalRequestArtifactHeaderV1(request),
        body: JSON.stringify(request), updatedAt: request.updatedAtMs } : null;
    };
    // Only durable Artifact IO is substituted. Ingress reconciliation, grant
    // admission, queue projection and decision transitions remain real.
    const executor = createActionExecutor({
      ...createUnavailableHostActionDeps(),
      approvalsList: args => listApprovalArtifactsV1({ ...args, read,
        readPage: async options => ({ items: [...artifacts].map(([artifactId, request]) => ({
          artifactId, header: buildApprovalRequestArtifactHeaderV1(request),
          body: JSON.stringify(request), updatedAt: request.updatedAtMs,
        })).filter(row => options.headerFilter?.(row.header) ?? true) }),
      }),
      approvalsGet: async ({ artifactId }) => artifacts.get(artifactId) ?? null,
      approvalsUpdate: async ({ artifactId, request }) => {
        const previous = artifacts.get(artifactId);
        if (!previous) throw new Error('Missing test Artifact');
        const next = ApprovalRequestV2Schema.parse(request);
        const admitted = decideApprovalRequestTransition(previous, next);
        if (!admitted.ok) return admitted;
        artifacts.set(artifactId, next);
        return { ok: true };
      },
    });
    const sessionHttp = vi.spyOn(axios, 'get').mockImplementation(async url => {
      if (new URL(String(url)).pathname !== '/v2/sessions/session-1') throw new Error('Unexpected Session HTTP request');
      return { status: 200, data: { session: createSessionRecordFixture({ id: 'session-1',
        encryptionMode: 'plain', dataEncryptionKey: null }) } };
    });
    const resolveTarget = createDaemonExternalActionTargetResolver({ credentials: { token: 'fixture-token', encryption: null },
      serverApiUrl: 'https://home.test' });
    const invoke = (actionId: 'approval.request.list' | 'approval.request.get' | 'approval.request.decide', input: unknown) => executeExternalAction({
      actionId, envelope: { v: 1, target: { kind: 'session', sessionId: 'session-1' }, input },
      principal: { ...principal, grant: { ...API_TOKEN_FULL_GRANT_V1, approve: true,
        actions: { families: [], ids: ['session.status.get'] }, targets: { sessions: ['session-1'], machines: [] } } },
      currentMachineId: 'machine-1', currentServerId: 'server-1',
      resolveTarget, executor,
    });
    try {
    const listed = await invoke('approval.request.list', { status: 'open', limit: 100 });
    expect(listed).toMatchObject({ kind: 'response', response: { execution: { ok: true,
      result: { items: [{ artifactId: 'session-1', sessionId: 'session-1' }], nextCursor: null } } } });
    if (listed.kind !== 'response' || listed.response.v !== 1 || !listed.response.execution.ok) throw new Error('Expected approval list');
    expect(listed.response.execution.result).toHaveProperty('items.length', 1);
    expect(await invoke('approval.request.get', { artifactId: 'session-1' })).toMatchObject({
      kind: 'response', response: { execution: { ok: true, result: { request: { status: 'open' } } } },
    });
    expect(await invoke('approval.request.get', { artifactId: 'session-2' })).toMatchObject({
      kind: 'response', response: { execution: { ok: false, errorCode: 'approval_not_found' } },
    });
    expect(await invoke('approval.request.decide', { artifactId: 'session-2', decision: 'reject' })).toMatchObject({
      kind: 'response', response: { execution: { ok: false, errorCode: 'credential_scope_denied' } },
    });
    expect(await invoke('approval.request.decide', { artifactId: 'session-1', decision: 'reject' })).toMatchObject({
      kind: 'response', response: { execution: { ok: true } },
    });
    expect(artifacts.get('session-1')?.status).toBe('rejected');
    expect(artifacts.get('session-2')?.status).toBe('open');
    } finally { sessionHttp.mockRestore(); }
  });

  it('limits Machine-scoped approval observation to admitted subjects before disclosing bodies', async () => {
    const approval = (machineId?: string, sessionId?: string, subjectMachineId = machineId) => ApprovalRequestV2Schema.parse({
      v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
      createdBy: { surface: 'agent', ...(sessionId ? { sessionId } : {}) }, requestedSurface: 'agent',
      actionId: 'machines.daemon.stop', actionArgs: { machineId: subjectMachineId }, summary: 'Stop Machine',
      executionOriginV1: { v: 1, authority: 'account_automation', surface: 'agent', caller: { kind: 'host' },
        actionId: 'machines.daemon.stop', accountId: 'account-1', serverId: 'server-1',
        ...(machineId ? { machineId } : {}), ...(sessionId ? { sessionId } : {}),
        ...(subjectMachineId ? { target: { kind: 'machine', machineId: subjectMachineId } } : {}),
        requestId: `stop-${machineId ?? 'unknown'}-${sessionId ?? 'machine'}` },
    });
    const own = approval('machine-1');
    const other = approval('machine-2');
    const sessionApproval = (machineId: string, sessionId: string) => ApprovalRequestV2Schema.parse({
      ...approval(machineId, sessionId), actionId: 'session.title.set',
      actionArgs: { sessionId, title: 'Reviewed title' }, summary: 'Rename Session',
      executionOriginV1: { ...own.executionOriginV1, machineId, sessionId, actionId: 'session.title.set',
        target: { kind: 'session', sessionId } },
    });
    const contributed = TargetActionApprovalRequestV1Schema.parse({
      v: 1, kind: 'plugin_target_action', status: 'open', createdAtMs: 1, updatedAtMs: 1,
      createdBy: { surface: 'system' }, requestedSurface: 'api',
      qualifiedActionId: 'acme.publisher/actions/releases/publish', input: {}, summary: 'Publish',
      sourceCustody: { kind: 'managed', immutableGenerationId: 'generation-1', installSource: 'npm' },
      policyFingerprint: 'a'.repeat(64), subjectFingerprint: 'b'.repeat(64),
      replayPlacement: { serverId: 'server-1', machineId: 'machine-1' },
      executionOriginV1: { ...own.executionOriginV1, surface: 'api', actionId: 'action.invoke',
        principalId: 'principal-1', credentialId: 'credential-1' },
    });
    const row = (artifactId: string, request: ApprovalRequest, header = buildApprovalRequestArtifactHeaderV1(request)) => ({
      artifactId, header, body: JSON.stringify(request), createdAt: 1, updatedAt: 1,
    });
    const legacyRow = (artifactId: string, request: ApprovalRequest) => {
      const { approvalTargetKind: _targetKind, ...header } = buildApprovalRequestArtifactHeaderV1(request);
      return row(artifactId, request, header);
    };
    const rows = [
      row('own', own), row('other', other), row('unknown', approval()),
      row('own-machine-from-session', approval('machine-1', 'session-2')),
      legacyRow('legacy-machine-from-session', approval('machine-1', 'session-2')),
      legacyRow('legacy-misplaced-session', sessionApproval('machine-1', 'session-2')),
      row('own-session', sessionApproval('machine-1', 'session-1')),
      row('own-session-again', sessionApproval('machine-1', 'session-1')),
      row('moved-session', sessionApproval('machine-old', 'session-1')),
      row('other-session', sessionApproval('machine-2', 'session-2')),
      row('misplaced-session', sessionApproval('machine-1', 'session-2')),
      row('unknown-session', sessionApproval('machine-1', 'session-unknown')),
      row('spoofed', other, buildApprovalRequestArtifactHeaderV1(own)),
      { artifactId: 'contributed', header: buildTargetActionApprovalArtifactHeaderV1(contributed),
        body: JSON.stringify(contributed), createdAt: 1, updatedAt: 1 },
      ...Array.from({ length: 1000 }, (_, index) => row(`ungranted-${index}`, other)),
    ];
    const hydratedIds: string[] = [];
    const localityReads: string[] = [];
    const read = async (artifactId: string) => rows.find(row => row.artifactId === artifactId) ?? null;
    // Substitute only Artifact persistence. Ingress, credential admission,
    // private-header selection and authoritative body parsing remain real.
    const executor = createActionExecutor({ ...createUnavailableHostActionDeps(),
      // The authenticated Session locality port is a host persistence/network
      // boundary; the observation owner still makes every grant decision.
      resolveApiTokenGrantSessionMachineId: async ({ sessionId }) => {
        localityReads.push(sessionId);
        return sessionId === 'session-1' ? 'machine-1' : sessionId === 'session-2' ? 'machine-2' : null;
      },
      approvalsList: args => listApprovalArtifactsV1({ ...args, read,
        readPage: options => listArtifactHeadersV1({ options,
          readPage: async () => ({ items: rows.map(({ body: _body, ...header }) => header),
            kindCoverage: { status: 'complete' as const, unclassifiedCount: 0 as const } }), encodeCursor: row => row.artifactId,
          readBodies: async selected => {
            hydratedIds.push(...selected.map(row => row.artifactId));
            return selected.map(row => ({ ...row, body: rows.find(stored => stored.artifactId === row.artifactId)!.body }));
          },
        }),
      }),
      approvalsGet: async ({ artifactId }) => {
        const stored = await read(artifactId);
        const parsed = stored && approvalArtifactBodyMatchesHeaderV1(stored.header, stored.body);
        return parsed && parsed.family !== 'execution_run_host_action' ? parsed.request : null;
      },
    });
    const invoke = (actionId: 'approval.request.list' | 'approval.request.get', input: unknown, unrestricted = false) => executeExternalAction({
      actionId, envelope: { v: 1, target: { kind: 'machine', machineId: 'machine-1' }, input },
      principal: { ...principal, grant: ApiTokenGrantV1Schema.parse(unrestricted ? { ...API_TOKEN_FULL_GRANT_V1, approve: true }
        : { ...API_TOKEN_FULL_GRANT_V1, approve: true, actions: { families: [], ids: ['session.status.get'] },
          targets: { sessions: [], machines: ['machine-1'] } }) },
      currentMachineId: 'machine-1', currentServerId: 'server-1', executor,
      resolveTarget: createDaemonExternalActionTargetResolver({ credentials: { token: 'synthetic-token', encryption: null } }),
    });
    const listed = await invoke('approval.request.list', { status: 'open', limit: 100 });
    expect(listed).toMatchObject({ kind: 'response', response: { execution: { ok: true,
      result: { items: expect.arrayContaining([{ artifactId: 'own', status: 'open', actionId: 'machines.daemon.stop',
        summary: 'Stop Machine', serverId: 'server-1', updatedAtMs: 1 }]) } } } });
    if (listed.kind !== 'response' || listed.response.v !== 1 || !listed.response.execution.ok) throw new Error('Expected approval list');
    const admittedIds = ['own', 'own-machine-from-session', 'legacy-machine-from-session', 'own-session', 'own-session-again', 'moved-session', 'contributed'];
    expect(listed.response.execution.result).toHaveProperty('items.length', admittedIds.length);
    expect(listed.response.execution.result).toHaveProperty('items', expect.arrayContaining(
      admittedIds.map(artifactId => expect.objectContaining({ artifactId }))));
    expect(hydratedIds.sort()).toEqual(['contributed', 'legacy-machine-from-session', 'legacy-misplaced-session', 'moved-session', 'own', 'own-machine-from-session', 'own-session', 'own-session-again', 'spoofed']);
    expect(localityReads.sort()).toEqual(['session-1', 'session-2', 'session-unknown']);
    for (const artifactId of admittedIds) expect(await invoke('approval.request.get', { artifactId })).toMatchObject({
      kind: 'response', response: { execution: { ok: true } },
    });
    for (const artifactId of ['other', 'other-session', 'misplaced-session', 'legacy-misplaced-session', 'unknown-session', 'unknown', 'spoofed']) expect(await invoke('approval.request.get', { artifactId })).toMatchObject({
      kind: 'response', response: { execution: { ok: false, errorCode: 'approval_not_found' } },
    });
    expect(await invoke('approval.request.get', { artifactId: 'other' }, true)).toMatchObject({
      kind: 'response', response: { execution: { ok: true } },
    });
    expect(await invoke('approval.request.get', { artifactId: 'unknown' }, true)).toMatchObject({
      kind: 'response', response: { execution: { ok: true } },
    });
  });

  it('preserves an explicitly trusted CLI surface on signed-root ingress', async () => {
    const execute = vi.fn<ExternalActionExecutor['execute']>(async () => ({
      ok: true,
      result: { installed: true },
    }));

    await executeExternalAction({
      actionId: 'plugins.install',
      envelope: { v: 1, input: { source: '/workspace/plugin' } },
      principal: { authority: 'present_user' },
      surface: 'cli',
      currentMachineId: 'machine-1',
      resolveTarget: async () => ({ kind: 'machine', machineId: 'machine-1' }),
      executor: { execute },
    });

    expect(execute).toHaveBeenCalledWith(
      'plugins.install',
      { source: '/workspace/plugin' },
      expect.objectContaining({ surface: 'cli', authority: 'present_user' }),
    );
  });

  it('stamps a signed workflow project target into host context only on its exact daemon', async () => {
    const target = {
      kind: 'machine' as const,
      machineId: 'machine-1',
      project: { machineId: 'machine-1', directory: '~/projects/app', workspaceRefId: 'workspace-1' },
    };
    const execute = vi.fn<ExternalActionExecutor['execute']>(async () => ({ ok: true, result: {} }));
    await executeExternalAction({
      actionId: 'workflow.run.start',
      envelope: { v: 1, input: { runId: '11111111-1111-4111-8111-111111111111', source: { kind: 'inline', definition: { version: 1, inputs: [], defaults: {}, blocks: [] } } }, target },
      principal,
      currentMachineId: 'machine-1',
      resolveTarget: async ({ target: resolved }) => resolved ?? null,
      executor: { execute },
    });
    expect(execute).toHaveBeenCalledWith('workflow.run.start', expect.anything(), expect.objectContaining({
      externalActionTarget: target,
    }));
  });

  it('binds a V1 request without correlation to its outer Machine and signs its resolved Session approval input', async () => {
    const keyPair = tweetnacl.sign.keyPair();
    const envelope = {
      v: 1 as const,
      input: { sessionId: 'session-1', title: 'Exact title' },
    };
    const authorization = {
      v: 1 as const,
      token: 'opaque-home-authorization',
      binding: {
        serverIdentityId: 'srv-cryptographic-home',
        accountId: principal.accountId,
        principalId: principal.principalId,
        credentialId: principal.credentialId,
        machineId: 'machine-implied',
        custodianAccountId: principal.accountId,
        installationId: 'installation-1',
        actionId: 'session.title.set',
        requestId: 'home-generated-request',
        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
        target: { kind: 'machine' as const, machineId: 'machine-implied' },
        grant: API_TOKEN_FULL_GRANT_V1,
      },
    };
    const execute = vi.fn<ExternalActionExecutor['execute']>(async (_actionId, actionInput, context) => {
      const signature = context?.signExternalActionApprovalInput?.({
        actionId: 'session.title.set',
        input: actionInput,
        target: context.externalActionTarget!,
        authorization,
      });
      expect(verifyExternalActionApprovalInputV1({
        authorizationToken: authorization.token,
        actionId: 'session.title.set',
        target: { kind: 'session', sessionId: 'session-1' },
        input: envelope.input,
        publicKey: keyPair.publicKey,
        signature: signature ?? '',
      })).toBe(true);
      return { ok: false, errorCode: 'expected_test_stop', error: 'expected_test_stop' };
    });

    await executeExternalAction({
      actionId: 'session.title.set',
      envelope,
      principal,
      currentMachineId: 'machine-implied',
      currentServerId: 'local-profile-id',
      currentInstallationId: 'installation-1', verifyExecutionAuthorization: async () => true,
      executionAuthorization: authorization,
      externalActionMachineRequestPrivateKey: keyPair.secretKey,
      resolveTarget: async () => ({ kind: 'session', sessionId: 'session-1' }),
      executor: { execute },
    });

    expect(execute).toHaveBeenCalledWith(
      'session.title.set',
      envelope.input,
      expect.objectContaining({
        actionRequestId: 'home-generated-request',
        serverId: 'local-profile-id',
        externalActionTarget: { kind: 'session', sessionId: 'session-1' },
        externalActionExecutionAuthorization: authorization,
      }),
    );
  });

  it('admits the ordinary PAT V1 Session carrier for an E2EE Account while enforcing its Session grant', async () => {
    const target = { kind: 'session' as const, sessionId: 'session-1' };
    const grant = { ...API_TOKEN_FULL_GRANT_V1,
      actions: { families: [], ids: ['session.board.get'] }, targets: { sessions: [target.sessionId], machines: [] } };
    const pat = { ...principal, grant };
    const reads: string[] = [];
    // Board transport is the persistence/network boundary; carrier parsing,
    // target reconciliation, grant admission and Action execution remain real.
    const executor = createActionExecutor({ ...createUnavailableHostActionDeps(),
      sessionBoardAction: async ({ input }) => {
        const sessionId = SessionBoardGetInputV1Schema.parse(input).sessionId!;
        reads.push(sessionId);
        return projectSessionBoardGetResultV1({ serverId: 'home-profile', sessionId, layout: null,
          entries: [], incomplete: false, capabilities: { readTranscript: true, editSessionRecords: false },
          page: { cursor: null, hasNext: false } });
      },
    });
    const run = (sessionId: string) => {
      const envelope = { v: 1 as const, target: { ...target, sessionId }, input: { sessionId } };
      return executeExternalAction({ actionId: 'session.board.get', envelope, principal: pat,
        currentMachineId: 'machine-1', currentServerId: 'home-profile', currentInstallationId: 'installation-1',
        executionAuthorization: { v: 1, token: 'opaque-home-authorization', binding: {
          accountId: pat.accountId, principalId: pat.principalId, credentialId: pat.credentialId, grant,
          accountEncryptionMode: 'e2ee', serverIdentityId: 'srv_home', machineId: 'machine-1',
          custodianAccountId: pat.accountId, installationId: 'installation-1', actionId: 'session.board.get',
          requestId: 'home-generated-request', target: envelope.target,
          requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
        } },
        externalActionMachineRequestPrivateKey: tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(23)).secretKey,
        verifyExecutionAuthorization: async () => true,
        resolveTarget: async ({ target: resolved }) => resolved ?? null, executor,
      });
    };
    expect(await run(target.sessionId)).toMatchObject({ kind: 'response', response: {
      v: 1, execution: { ok: true, result: { sessionId: target.sessionId, items: [], incomplete: false } },
    } });
    expect(await run('outside-session')).toMatchObject({ kind: 'response', response: {
      execution: { ok: false, errorCode: 'credential_scope_denied' },
    } });
    expect(reads).toEqual([target.sessionId]);
  });

  it.each(['account', 'terminal'] as const)('keeps signed %s private origination on protected V2 for an E2EE Account', async kind => {
    const target = { kind: 'session' as const, sessionId: 'session-1' };
    const envelope = { v: 1 as const, requestId: 'signed-private-request', target, input: { sessionId: target.sessionId } };
    const authentication = { kind, tokenEpoch: 1 };
    const result = await executeExternalAction({ actionId: 'session.board.get', envelope,
      principal: ExternalActionServerPrincipalV1Schema.parse({ accountId: principal.accountId, authority: 'account_automation', authentication }),
      currentMachineId: 'machine-1', currentServerId: 'home-profile', currentInstallationId: 'installation-1',
      executionAuthorization: ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'opaque-home-authorization', binding: {
        accountId: principal.accountId, authentication, accountEncryptionMode: 'e2ee',
        serverIdentityId: 'srv_home', machineId: 'machine-1', custodianAccountId: principal.accountId,
        installationId: 'installation-1', actionId: 'session.board.get', requestId: envelope.requestId, target,
        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
      } }),
      externalActionMachineRequestPrivateKey: tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(23)).secretKey,
      verifyExecutionAuthorization: async () => true,
      resolveTarget: async () => { throw new Error('Private V1 must refuse before target reads'); },
      executor: createActionExecutor(createUnavailableHostActionDeps()),
    });
    expect(result).toEqual({ kind: 'invalid_request', errorCode: 'invalid_envelope', requestId: envelope.requestId });
  });

  it('rejects a protected Machine binding before Session reconciliation can select this daemon', async () => {
    const material = { type: 'dataKey' as const, machineKey: new Uint8Array(32).fill(9) };
    const binding = { serverIdentityId: 'srv_test', accountId: principal.accountId,
      credentialId: '00000000-0000-4000-8000-000000000001', actionId: 'session.message.send',
      requestId: 'wrong-receiver', target: { kind: 'machine' as const, machineId: 'other-machine' } };
    const envelope = sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding, material,
      input: { sessionId: 'session-1', message: 'private-input' }, randomBytes: (length) => new Uint8Array(length).fill(2) });
    const result = await executeExternalAction({ actionId: binding.actionId, envelope,
      principal: { ...principal, credentialId: binding.credentialId }, currentMachineId: 'machine-1',
      resolveEncryption: async () => ({ serverIdentityId: binding.serverIdentityId, material }),
      resolveTarget: async () => { throw new Error('Wrong receiving Machine must reject before target resolution'); },
      executor: { execute: async () => { throw new Error('Wrong receiving Machine cannot execute'); } },
    });
    expect(result).toEqual({
      kind: 'invalid_request',
      errorCode: 'invalid_encrypted_envelope',
      requestId: 'wrong-receiver',
    });
  });

  it('rejects a foreign Session target before a Session-bound receiver opens the envelope', async () => {
    const material = { type: 'dataKey' as const, machineKey: new Uint8Array(32).fill(9) };
    const binding = { serverIdentityId: 'srv_test', accountId: principal.accountId,
      credentialId: '00000000-0000-4000-8000-000000000001', actionId: 'session.message.send',
      requestId: 'foreign-session', target: { kind: 'session' as const, sessionId: 'session-other' } };
    const envelope = sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding, material,
      input: { sessionId: 'session-other', message: 'private-input' },
      randomBytes: (length) => new Uint8Array(length).fill(2) });
    const resolveTarget = vi.fn<ResolveExternalActionTarget>();
    const result = await executeExternalAction({ actionId: binding.actionId, envelope,
      principal: { ...principal, credentialId: binding.credentialId }, currentMachineId: 'machine-1',
      currentSessionId: 'session-own',
      // This receiver's own material would open the envelope, so the refusal is
      // the bound-Session guard and not a failed open.
      resolveEncryption: async () => ({ serverIdentityId: binding.serverIdentityId, material }),
      resolveTarget,
      executor: { execute: async () => { throw new Error('A foreign Session cannot execute'); } },
    });
    expect(result).toEqual({
      kind: 'invalid_request',
      errorCode: 'invalid_encrypted_envelope',
      requestId: 'foreign-session',
    });
    expect(resolveTarget).not.toHaveBeenCalled();
  });

  it('keeps a many-Session daemon deciding the same foreign Session at its target owner', async () => {
    // The same envelope as the case above. Without a bound Session the receiver
    // cannot answer the question before opening, so the decision stays with
    // `resolveTarget` exactly as it did before that fact existed.
    const material = { type: 'dataKey' as const, machineKey: new Uint8Array(32).fill(9) };
    const binding = { serverIdentityId: 'srv_test', accountId: principal.accountId,
      credentialId: '00000000-0000-4000-8000-000000000001', actionId: 'session.message.send',
      requestId: 'foreign-session', target: { kind: 'session' as const, sessionId: 'session-other' } };
    const envelope = sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding, material,
      input: { sessionId: 'session-other', message: 'private-input' },
      randomBytes: (length) => new Uint8Array(length).fill(2) });
    const resolveTarget = vi.fn<ResolveExternalActionTarget>(async () => null);
    const result = await executeExternalAction({ actionId: binding.actionId, envelope,
      principal: { ...principal, credentialId: binding.credentialId }, currentMachineId: 'machine-1',
      resolveEncryption: async () => ({ serverIdentityId: binding.serverIdentityId, material }),
      resolveTarget,
      executor: { execute: async () => { throw new Error('A foreign Session cannot execute'); } },
    });
    expect(result.kind).toBe('response');
    expect(resolveTarget).toHaveBeenCalledTimes(1);
  });

  it('keeps admitting its own bound Session on a Session-bound receiver', async () => {
    const material = { type: 'dataKey' as const, machineKey: new Uint8Array(32).fill(9) };
    const binding = { serverIdentityId: 'srv_test', accountId: principal.accountId,
      credentialId: '00000000-0000-4000-8000-000000000001', actionId: 'session.message.send',
      requestId: 'own-session', target: { kind: 'session' as const, sessionId: 'session-own' } };
    const envelope = sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding, material,
      input: { sessionId: 'session-own', message: 'hello' },
      randomBytes: (length) => new Uint8Array(length).fill(2) });
    const resolveTarget = vi.fn<ResolveExternalActionTarget>(async () => binding.target);
    const result = await executeExternalAction({ actionId: binding.actionId, envelope,
      principal: { ...principal, credentialId: binding.credentialId }, currentMachineId: 'machine-1',
      currentSessionId: 'session-own',
      resolveEncryption: async () => ({ serverIdentityId: binding.serverIdentityId, material }),
      resolveTarget,
      executor: { execute: async () => ({ ok: true, result: { status: 'accepted', localId: 'local-1' } }) },
    });
    expect(result.kind).toBe('response');
    expect(resolveTarget).toHaveBeenCalledTimes(1);
  });

  it('rejects a present authorization whose immutable envelope binding does not match', async () => {
    const execute = vi.fn<ExternalActionExecutor['execute']>();
    const resolveTarget = vi.fn<ResolveExternalActionTarget>();
    const envelope = { v: 1 as const, requestId: 'request-1', input: {} };
    await expect(executeExternalAction({
      actionId: 'action.spec.get',
      envelope,
      principal,
      currentMachineId: 'machine-1',
      currentServerId: 'server-1',
      externalActionMachineRequestPrivateKey: tweetnacl.sign.keyPair().secretKey,
      currentInstallationId: 'installation-1', verifyExecutionAuthorization: async () => true,
      executionAuthorization: {
        v: 1,
        token: 'opaque-home-authorization',
        binding: {
          serverIdentityId: 'server-1',
          accountId: principal.accountId,
          principalId: principal.principalId,
          credentialId: principal.credentialId,
          grant: principal.grant,
          machineId: 'machine-1',
          custodianAccountId: principal.accountId,
          installationId: 'installation-1',
          actionId: 'action.spec.get',
          requestId: envelope.requestId,
          requestEnvelopeDigest: 'A'.repeat(43),
          target: { kind: 'machine', machineId: 'machine-1' },
        },
      },
      resolveTarget,
      executor: { execute },
    })).resolves.toEqual({
      kind: 'invalid_request',
      errorCode: 'invalid_envelope',
      requestId: 'request-1',
    });
    expect(resolveTarget).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('returns a correlated protected transport failure when V2 omits its target', async () => {
    const resolveTarget = vi.fn<ResolveExternalActionTarget>();
    const execute = vi.fn<ExternalActionExecutor['execute']>();

    await expect(executeExternalAction({
      actionId: 'session.message.send',
      envelope: {
        v: 2,
        requestId: 'protected-missing-target',
        payload: { t: 'encrypted', c: 'opaque' },
      },
      principal,
      currentMachineId: 'machine-1',
      resolveTarget,
      executor: { execute },
    })).resolves.toEqual({
      kind: 'invalid_request',
      errorCode: 'target_required',
      requestId: 'protected-missing-target',
    });
    expect(resolveTarget).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('opens V2 before canonical target reconciliation and seals its complete rejection', async () => {
    const material = { type: 'dataKey' as const, machineKey: new Uint8Array(32).fill(9) };
    const binding = {
      serverIdentityId: 'srv_test', accountId: principal.accountId,
      credentialId: '00000000-0000-4000-8000-000000000001',
      actionId: 'session.message.send', requestId: 'protected-reconciliation',
      target: { kind: 'session' as const, sessionId: 'session-1' },
    };
    const request = sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1,
      binding, material, randomBytes: (length) => new Uint8Array(length).fill(2),
      input: { sessionId: 'different-session', message: 'private-input-sentinel' },
    });
    const result = await executeExternalAction({
      actionId: binding.actionId, envelope: request,
      principal: { ...principal, credentialId: binding.credentialId },
      currentMachineId: 'machine-1',
      resolveEncryption: async () => ({ serverIdentityId: binding.serverIdentityId, material }),
      // These are unreachable after the real reconciliation rejects conflicting targets.
      resolveTarget: async () => { throw new Error('Target lookup must not run'); },
      executor: { execute: async () => { throw new Error('Action must not execute'); } },
    });
    expect(result.kind).toBe('response');
    if (result.kind !== 'response') throw new Error('Expected encrypted rejection');
    expect(result.response.v).toBe(2);
    expect(result.prepared.body).not.toContain('private-input-sentinel');
    expect(openExternalActionResponseV2({ envelope: result.response, binding, request, material }))
      .toMatchObject({ ok: false, errorCode: 'target_not_local' });
  });

  it('seals an executor exception after opening V2 instead of exposing a plaintext transport failure', async () => {
    const diagnostic = vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => {});
    const material = { type: 'dataKey' as const, machineKey: new Uint8Array(32).fill(7) };
    const binding = {
      serverIdentityId: 'srv_test', accountId: principal.accountId,
      credentialId: '00000000-0000-4000-8000-000000000001',
      actionId: 'session.activity.get', requestId: 'protected-executor-failure',
      target: { kind: 'machine' as const, machineId: 'machine-1' },
    };
    const request = sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1,
      binding,
      material,
      input: { sessionId: 'session-1' },
      randomBytes: (length) => new Uint8Array(length).fill(3),
    });

    const result = await executeExternalAction({
      actionId: binding.actionId,
      envelope: request,
      principal: { ...principal, credentialId: binding.credentialId },
      currentMachineId: 'machine-1',
      resolveEncryption: async () => ({ serverIdentityId: binding.serverIdentityId, material }),
      resolveTarget: async () => binding.target,
      executor: { execute: async () => { throw Object.assign(new TypeError('private executor failure'), {
        code: 'EIO', stack: 'TypeError: private executor failure\n    at privateCall (/srv/happier/action.ts:42:9)',
      }); } },
    });

    expect(result.kind).toBe('response');
    if (result.kind !== 'response') throw new Error('Expected encrypted failure');
    expect(result.response.v).toBe(2);
    expect(result.prepared.body).not.toContain('private executor failure');
    expect(openExternalActionResponseV2({ envelope: result.response, binding, request, material }))
      .toMatchObject({ ok: false, errorCode: 'action_outcome_unknown' });
    expect(diagnostic.mock.calls.filter(([tag]) => tag === '[external-action-phase]')).toEqual([
      ['[external-action-phase]', expect.objectContaining({ actionId: binding.actionId, requestId: binding.requestId,
        phase: 'action_execution', errorClass: 'TypeError', errorCode: 'EIO',
        stackFrames: [{ file: '/srv/happier/action.ts', line: 42, column: 9 }] })],
    ]);
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('private');
    diagnostic.mockRestore();
  });

  it('admits client placement to the canonical executor for connected app delivery', async () => {
    const resolveTarget = vi.fn<ResolveExternalActionTarget>(async () => ({ kind: 'machine', machineId: 'machine-1' }));
    const execute = vi.fn<ExternalActionExecutor['execute']>(async () => ({ ok: false, errorCode: 'unavailable', error: 'noClient' }));

    await expect(executeExternalAction({
      actionId: 'ui.current_context.read',
      envelope: { v: 1, requestId: 'request-client-placement', input: {} },
      principal,
      currentMachineId: 'machine-1',
      resolveTarget,
      executor: { execute },
    })).resolves.toMatchObject({
      kind: 'response',
      response: {
        v: 1,
        actionId: 'ui.current_context.read',
        requestId: 'request-client-placement',
        execution: {
          ok: false,
          errorCode: 'unavailable',
          error: 'noClient',
        },
      },
    });
    expect(resolveTarget).toHaveBeenCalled();
    expect(execute).toHaveBeenCalledWith('ui.current_context.read', {}, expect.objectContaining({ authority: 'account_automation' }));
  });

  it('projects the exact public Session admission result before returning it', async () => {
    const base = {
      actionId: 'session.message.send',
      principal,
      currentMachineId: 'machine-1',
      resolveTarget: async () => ({ kind: 'machine' as const, machineId: 'machine-1' }),
    };
    const envelope = {
      v: 1 as const,
      target: { kind: 'machine' as const, machineId: 'machine-1' },
      input: { sessionId: 'session-1', message: 'continue', localId: 'caller-local-id' },
    };

    await expect(executeExternalAction({
      ...base,
      envelope,
      executor: { execute: async () => ({
        ok: true,
        result: { status: 'accepted', localId: 'caller-local-id' },
      }) },
    })).resolves.toMatchObject({
      kind: 'response',
      response: {
        execution: { ok: true, result: { status: 'accepted', localId: 'caller-local-id' } },
      },
    });

    await expect(executeExternalAction({
      ...base,
      envelope,
      executor: { execute: async () => ({
        ok: true,
        result: { status: 'accepted', localId: 'caller-local-id', privateDiagnostic: true },
      }) },
    })).resolves.toMatchObject({
      kind: 'response',
      response: {
        execution: {
          ok: false,
          errorCode: 'invalid_action_output',
          error: 'invalid_action_output',
        },
      },
    });
  });

  it('returns the one prepared direct-HTTP response projection from the ingress owner', async () => {
    const result = await executeExternalAction({
      actionId: 'session.spawn_new',
      envelope: { v: 1, requestId: 'request-prepared', input: {} },
      principal,
      currentMachineId: 'machine-1',
      resolveTarget: async () => ({ kind: 'machine', machineId: 'machine-1' }),
      executor: {
        execute: async () => ({ ok: true, result: SESSION_SPAWN_PENDING_RESULT }),
      },
    });

    expect(result).toMatchObject({
      kind: 'response',
      prepared: {
        response: {
          v: 1,
          actionId: 'session.spawn_new',
          requestId: 'request-prepared',
          execution: { ok: true, result: SESSION_SPAWN_PENDING_RESULT },
        },
      },
    });
    if (result.kind !== 'response') throw new Error('expected admitted response');
    expect(result.prepared.body).toBe(JSON.stringify(result.prepared.response));
    expect(result.prepared.byteLength).toBe(new TextEncoder().encode(result.prepared.body).byteLength);
  });

  it.each([
    ['BigInt', () => ({ value: BigInt(1) })],
    ['cyclic data', () => {
      const value: Record<string, unknown> = {};
      value.self = value;
      return value;
    }],
  ])('projects reachable non-JSON failure details from %s to invalid_action_output', async (_case, details) => {
    const execute = vi.fn<ExternalActionExecutor['execute']>(async () => ({
      ok: false,
      errorCode: 'action_failed',
      error: 'action_failed',
      details: details(),
    }));

    await expect(executeExternalAction({
      actionId: 'session.spawn_new',
      envelope: { v: 1, input: {} },
      principal,
      currentMachineId: 'machine-1',
      resolveTarget: async () => ({ kind: 'machine', machineId: 'machine-1' }),
      executor: { execute },
    })).resolves.toMatchObject({
      kind: 'response',
      response: {
        v: 1,
        actionId: 'session.spawn_new',
        execution: {
          ok: false,
          errorCode: 'invalid_action_output',
          error: 'invalid_action_output',
        },
      },
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('accepts an exact-limit multibyte response, replaces one-byte-over after execution, and remains usable', async () => {
    const exactLimitResult = createExactLimitMultibyteResult();
    if (!('session' in exactLimitResult)) throw new Error('Expected Session status');
    const overLimitResult = createSessionStatusResult(`${exactLimitResult.session.title}a`);
    const usableResult = createSessionStatusResult('Usable');
    const execute = vi.fn<ExternalActionExecutor['execute']>()
      .mockResolvedValueOnce({ ok: true, result: exactLimitResult })
      .mockResolvedValueOnce({ ok: true, result: overLimitResult })
      .mockResolvedValueOnce({ ok: true, result: usableResult });
    const request = {
      actionId: 'session.status.get',
      envelope: {
        v: 1,
        requestId: 'request-limit',
        target: { kind: 'session' as const, sessionId: 'session-1' },
        input: { sessionId: 'session-1' },
      },
      principal,
      currentMachineId: 'machine-1',
      resolveTarget: vi.fn<ResolveExternalActionTarget>(async ({ target }) => target ?? null),
      executor: { execute },
    } as const;

    const exact = await executeExternalAction(request);
    expect(exact.kind).toBe('response');
    if (exact.kind !== 'response') throw new Error('expected admitted response');
    expect(measureExternalActionResponseEnvelopeUtf8BytesV1(exact.response))
      .toBe(EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES);
    if (exact.response.v !== 1) throw new Error('expected an unsealed V1 response envelope');
    expect(exact.response.execution).toEqual({ ok: true, result: exactLimitResult });

    await expect(executeExternalAction(request)).resolves.toMatchObject({
      kind: 'response',
      response: {
        v: 1,
        actionId: 'session.status.get',
        requestId: 'request-limit',
        execution: {
          ok: false,
          errorCode: 'result_too_large',
          error: 'Action execution completed, but its response exceeded the external Action response limit and could not be represented.',
          details: {
            executionCompleted: true,
            maxSerializedBytes: EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES,
          },
        },
      },
    });

    await expect(executeExternalAction(request)).resolves.toMatchObject({
      kind: 'response',
      response: {
        v: 1,
        actionId: 'session.status.get',
        requestId: 'request-limit',
        execution: { ok: true, result: usableResult },
      },
    });
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it('stamps verified PAT provenance and the local machine target before one executor call', async () => {
    const signal = new AbortController().signal;
    const execute = vi.fn(async () => ({
      ok: true as const,
      result: SESSION_SPAWN_PENDING_RESULT,
    }));
    const resolveTarget = vi.fn(async () => ({ kind: 'machine' as const, machineId: 'machine-1' }));

    await expect(executeExternalAction({
      actionId: 'session.spawn_new',
      envelope: {
        v: 1,
        requestId: 'request-1',
        input: { directory: '/workspace', prompt: 'hello' },
      },
      principal: {
        accountId: 'account-1',
        principalId: 'principal-1',
        credentialId: 'credential-1',
        authority: 'account_automation',
      },
      currentMachineId: 'machine-1',
      currentAccountId: 'installed-custodian',
      resolveTarget,
      executor: { execute },
      signal,
    })).resolves.toMatchObject({
      kind: 'response',
      response: {
        v: 1,
        actionId: 'session.spawn_new',
        requestId: 'request-1',
        execution: { ok: true, result: SESSION_SPAWN_PENDING_RESULT },
      },
    });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(resolveTarget).toHaveBeenCalledWith({
      actionId: 'session.spawn_new',
      actionInput: { directory: '/workspace', prompt: 'hello' },
      target: undefined,
      context: { surface: 'api', actionCaller: undefined },
      currentMachineId: 'machine-1',
      signal,
    });
    expect(execute).toHaveBeenCalledWith(
      'session.spawn_new',
      { directory: '/workspace', prompt: 'hello' },
      {
        surface: 'api',
        authority: 'account_automation',
        runtimeAccountId: 'account-1',
        actionCaller: { kind: 'host' },
        actionRequestId: 'request-1',
        recordActionStartDiagnostic: expect.any(Function),
        externalActionCredential: expect.objectContaining({
          accountId: 'account-1',
          principalId: 'principal-1',
          credentialId: 'credential-1',
        }),
        externalActionTarget: { kind: 'machine', machineId: 'machine-1' },
        defaultSessionMachineId: 'machine-1',
        signal,
      },
    );
  });

  it('relays the canonical public failure projection for a contributed Action', async () => {
    const executor = {
      execute: async () => ({
        ok: false as const,
        errorCode: 'target_declined',
        error: 'Target rejected this request',
        details: { reason: 'policy' },
        retryable: true,
        data: { internalTargetState: 'declined' },
        actionHandlerInvocation: 'notStarted' as const,
      }),
    } as unknown as ExternalActionExecutor;
    const resolveTarget = vi.fn<ResolveExternalActionTarget>(async ({ target }) => target ?? null);

    const response = await executeExternalAction({
      actionId: 'action.invoke',
      envelope: {
        v: 1,
        target: { kind: 'machine', machineId: 'machine-1' },
        input: {
          action: { pluginId: 'acme.notes', localId: 'save-note' },
          input: { title: 'Quarterly notes' },
        },
      },
      principal: {
        accountId: 'account-1',
        principalId: 'principal-1',
        credentialId: 'credential-1',
        authority: 'account_automation',
      },
      currentMachineId: 'machine-1',
      resolveTarget,
      executor,
    });

    expect(response).toMatchObject({
      kind: 'response',
      response: {
        v: 1,
        actionId: 'action.invoke',
        execution: {
          ok: false,
          errorCode: 'target_declined',
          error: 'Target rejected this request',
          details: { reason: 'policy' },
        },
      },
    });
  });

  it('rejects a target for another machine without invoking the local executor', async () => {
    const execute = vi.fn();
    const resolveTarget = vi.fn(async () => null);

    await expect(executeExternalAction({
      actionId: 'session.spawn_new',
      envelope: {
        v: 1,
        target: { kind: 'machine', machineId: 'machine-2' },
        input: {},
      },
      principal: {
        accountId: 'account-1',
        principalId: 'principal-1',
        credentialId: 'credential-1',
        authority: 'account_automation',
      },
      currentMachineId: 'machine-1',
      resolveTarget,
      executor: { execute },
    })).resolves.toMatchObject({
      kind: 'response',
      response: {
        v: 1,
        actionId: 'session.spawn_new',
        execution: {
          ok: false,
          errorCode: 'target_not_local',
          error: 'target_not_local',
          details: { phase: 'target_machine_locality' },
        },
      },
    });

    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects an explicit session target that is no longer owned by this daemon', async () => {
    const execute = vi.fn();
    const resolveTarget = vi.fn(async () => null);

    await expect(executeExternalAction({
      actionId: 'session.open',
      envelope: {
        v: 1,
        target: { kind: 'session', sessionId: 'session-other-machine' },
        input: { sessionId: 'session-other-machine' },
      },
      principal: {
        accountId: 'account-1',
        principalId: 'principal-1',
        credentialId: 'credential-1',
        authority: 'account_automation',
      },
      currentMachineId: 'machine-1',
      resolveTarget,
      executor: { execute },
    })).resolves.toMatchObject({
      kind: 'response',
      response: {
        v: 1,
        actionId: 'session.open',
        execution: {
          ok: false,
          errorCode: 'target_not_local',
          error: 'target_not_local',
          details: { phase: 'target_session_locality' },
        },
      },
    });

    expect(resolveTarget).toHaveBeenCalledWith({
      actionId: 'session.open',
      actionInput: { sessionId: 'session-other-machine' },
      target: { kind: 'session', sessionId: 'session-other-machine' },
      currentMachineId: 'machine-1',
      context: { surface: 'api', actionCaller: undefined },
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('derives an unambiguous Session input as the exact target and stamps it as Action context', async () => {
    const execute = vi.fn(async () => ({ ok: true as const, result: { opened: true } }));
    const resolveTarget = vi.fn<ResolveExternalActionTarget>(async ({ target, currentMachineId }) => target ?? {
      kind: 'machine' as const,
      machineId: currentMachineId,
    });

    await expect(executeExternalAction({
      actionId: 'session.open',
      envelope: {
        v: 1,
        input: { sessionId: 'session-1' },
      },
      principal: {
        accountId: 'account-1',
        principalId: 'principal-1',
        credentialId: 'credential-1',
        authority: 'account_automation',
      },
      currentMachineId: 'machine-1',
      resolveTarget,
      executor: { execute },
    })).resolves.toMatchObject({
      kind: 'response',
      response: {
        v: 1,
        actionId: 'session.open',
        execution: { ok: true, result: { opened: true } },
      },
    });

    expect(resolveTarget).toHaveBeenCalledWith({
      actionId: 'session.open',
      actionInput: { sessionId: 'session-1' },
      target: { kind: 'session', sessionId: 'session-1' },
      currentMachineId: 'machine-1',
      context: { surface: 'api', actionCaller: undefined },
    });
    expect(execute).toHaveBeenCalledWith(
      'session.open',
      { sessionId: 'session-1' },
      expect.objectContaining({
        externalActionTarget: { kind: 'session', sessionId: 'session-1' },
        defaultSessionId: 'session-1',
        defaultSessionMachineId: 'machine-1',
      }),
    );
  });

  it('rejects a conventional Session selector that conflicts with the envelope target', async () => {
    const execute = vi.fn();
    const resolveTarget = vi.fn<ResolveExternalActionTarget>(async ({ target }) => target ?? null);

    await expect(executeExternalAction({
      actionId: 'session.open',
      envelope: {
        v: 1,
        target: { kind: 'session', sessionId: 'session-1' },
        input: { sessionId: 'session-2' },
      },
      principal: {
        accountId: 'account-1',
        principalId: 'principal-1',
        credentialId: 'credential-1',
        authority: 'account_automation',
      },
      currentMachineId: 'machine-1',
      resolveTarget,
      executor: { execute },
    })).resolves.toMatchObject({
      kind: 'response',
      response: {
        v: 1,
        actionId: 'session.open',
        execution: {
          ok: false,
          errorCode: 'target_not_local',
          error: 'target_not_local',
        },
      },
    });

    expect(resolveTarget).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('does not let a title-only session.open selector escape an exact Session target', async () => {
    const execute = vi.fn();
    const resolveTarget = vi.fn();

    await expect(executeExternalAction({
      actionId: 'session.open',
      envelope: {
        v: 1,
        target: { kind: 'session', sessionId: 'session-1' },
        input: { sessionTitle: 'untrusted title selector' },
      },
      principal: {
        accountId: 'account-1',
        principalId: 'principal-1',
        credentialId: 'credential-1',
        authority: 'account_automation',
      },
      currentMachineId: 'machine-1',
      resolveTarget,
      executor: { execute },
    })).resolves.toMatchObject({
      kind: 'response',
      response: {
        v: 1,
        actionId: 'session.open',
        execution: {
          ok: false,
          errorCode: 'target_required',
          error: 'target_required',
        },
      },
    });

    expect(resolveTarget).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('stamps the admitted machine only for a detached execution run', async () => {
    const execute = vi.fn(async () => ({ ok: true as const, result: { runs: [] } }));
    const resolveTarget = vi.fn<ResolveExternalActionTarget>(async ({ target }) => target ?? null);

    await expect(executeExternalAction({
      actionId: 'execution.run.list',
      envelope: {
        v: 1,
        target: { kind: 'machine', machineId: 'machine-1' },
        input: { sessionId: null },
      },
      principal: {
        accountId: 'account-1',
        principalId: 'principal-1',
        credentialId: 'credential-1',
        authority: 'account_automation',
      },
      currentMachineId: 'machine-1',
      resolveTarget,
      executor: { execute },
    })).resolves.toMatchObject({
      kind: 'response',
      response: { execution: { ok: true } },
    });

    expect(execute).toHaveBeenCalledWith(
      'execution.run.list',
      { sessionId: null },
      expect.objectContaining({ executionRunTargetMachineId: 'machine-1' }),
    );
  });

  it('refuses a machine-owned Action whose canonical machine input names another daemon', async () => {
    const execute = vi.fn();
    const resolveTarget = vi.fn();

    await expect(executeExternalAction({
      actionId: 'memory.ensure_up_to_date',
      envelope: {
        v: 1,
        input: { machineId: 'machine-elsewhere' },
      },
      principal: {
        accountId: 'account-1',
        principalId: 'principal-1',
        credentialId: 'credential-1',
        authority: 'account_automation',
      },
      currentMachineId: 'machine-1',
      resolveTarget,
      executor: { execute },
    })).resolves.toMatchObject({
      kind: 'response',
      response: {
        execution: {
          ok: false,
          errorCode: 'target_not_local',
        },
      },
    });

    expect(resolveTarget).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('does not mistake a Session handoff destination for an ingress target selector', async () => {
    const execute = vi.fn(async () => ({
      ok: true as const,
      result: {
        handoffId: 'handoff-1',
        status: {
          handoffId: 'handoff-1',
          status: 'completed' as const,
          phase: 'finalizing' as const,
          recoveryActions: [],
        },
        workspace: {
          kind: 'relationship' as const,
          relationshipId: 'relationship-1',
          created: true,
        },
      },
    }));
    const resolveTarget = vi.fn<ResolveExternalActionTarget>(async ({ target }) => target ?? null);

    await expect(executeExternalAction({
      actionId: 'session.handoff',
      envelope: {
        v: 1,
        target: { kind: 'session', sessionId: 'session-1' },
        input: { sessionId: 'session-1', targetMachineId: 'machine-elsewhere' },
      },
      principal: {
        accountId: 'account-1',
        principalId: 'principal-1',
        credentialId: 'credential-1',
        authority: 'account_automation',
      },
      currentMachineId: 'machine-1',
      resolveTarget,
      executor: { execute },
    })).resolves.toMatchObject({
      kind: 'response',
      response: { execution: { ok: true } },
    });

    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('rejects caller-owned authority before it reaches the Action executor', async () => {
    const execute = vi.fn();

    await expect(executeExternalAction({
      actionId: 'session.spawn_new',
      envelope: {
        v: 1,
        input: {},
        authority: 'present_user',
      },
      principal: {
        accountId: 'account-1',
        principalId: 'principal-1',
        credentialId: 'credential-1',
        authority: 'account_automation',
      },
      currentMachineId: 'machine-1',
      resolveTarget: vi.fn(),
      executor: { execute },
    })).resolves.toEqual({
      kind: 'invalid_request',
      errorCode: 'invalid_envelope',
    });

    expect(execute).not.toHaveBeenCalled();
  });

  it('validates the envelope before daemon Action-id admission for a syntactically valid unknown Action', async () => {
    const execute = vi.fn();
    const resolveTarget = vi.fn<ResolveExternalActionTarget>();

    await expect(executeExternalAction({
      actionId: 'unknown.public.action',
      envelope: { v: 1, input: { nonFinite: Number.POSITIVE_INFINITY } },
      principal,
      currentMachineId: 'machine-1',
      resolveTarget,
      executor: { execute },
    })).resolves.toEqual({
      kind: 'invalid_request',
      errorCode: 'invalid_envelope',
    });

    expect(resolveTarget).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('projects target-resolution faults as target_unavailable without leaking a route exception', async () => {
    const phaseLog = vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => {});
    const execute = vi.fn();
    const resolveTarget = vi.fn<ResolveExternalActionTarget>(async () => {
      throw new Error('Session ownership lookup failed');
    });

    await expect(executeExternalAction({
      actionId: 'session.spawn_new',
      envelope: { v: 1, requestId: 'target-resolution-fault', input: {} },
      principal,
      currentMachineId: 'machine-1',
      resolveTarget,
      executor: { execute },
    })).resolves.toMatchObject({
      kind: 'response',
      response: {
        requestId: 'target-resolution-fault',
        execution: {
          ok: false,
          effectAttempted: false,
          errorCode: 'target_unavailable',
          error: 'target_unavailable',
        },
      },
    });

    expect(execute).not.toHaveBeenCalled();
    expect(phaseLog).toHaveBeenCalledWith('[external-action-phase]', expect.objectContaining({
      machineId: 'machine-1', requestId: 'target-resolution-fault',
      refusalBranch: 'target_resolution_threw',
    }));
    phaseLog.mockRestore();
  });

  it('attributes a named session spawn refusal from the canonical executor exactly once', async () => {
    const phaseLog = vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => {});
    const sessionSpawnNew = vi.fn(async () => SESSION_SPAWN_PENDING_RESULT);
    const executor = createActionExecutor({
      ...createUnavailableHostActionDeps(),
      profileActionExecute: async () => ({ ok: true, result: { status: 'absent' } }),
      sessionSpawnNew,
    });

    const result = await executeExternalAction({
      actionId: 'session.spawn_new',
      envelope: {
        v: 1,
        requestId: 'QA62-named-request',
        target: { kind: 'machine', machineId: 'machine-1' },
        input: {
          creationKey: 'qa62-named-request',
          directory: { kind: 'managed' },
          agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
          profileId: 'missing-profile',
        },
      },
      principal,
      currentMachineId: 'machine-1',
      currentServerId: 'server-1',
      resolveTarget: async () => ({ kind: 'machine', machineId: 'machine-1' }),
      executor,
    });

    expect(result).toMatchObject({
      kind: 'response',
      response: { requestId: 'QA62-named-request', execution: { ok: false, errorCode: 'target_unavailable' } },
    });
    expect(phaseLog.mock.calls.filter(([event]) => event === '[external-action-phase]')).toEqual([
      ['[external-action-phase]', expect.objectContaining({
        machineId: 'machine-1', requestId: 'QA62-named-request',
        refusalBranch: 'profile_unavailable',
      })],
    ]);
    expect(sessionSpawnNew).not.toHaveBeenCalled();
    phaseLog.mockRestore();
  });
});
