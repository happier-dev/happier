import { resolveActionSessionTargets } from '@happier-dev/protocol/actions/executor/sessionTargets';
import { createExternalActionRuntime } from './externalActionRuntime.testkit';
import { unexpectedProjectNativeAdapterResolution } from "@/plugins/testkit/unexpectedProjectNativeAdapterResolution";
import { unexpectedCaptureSourceResolution } from "@/plugins/testkit/unexpectedCaptureSourceResolution";
import { afterEach, describe, expect, it, vi } from 'vitest';
import { logger } from '@/ui/logger';
import axios from 'axios';
import { isDeepStrictEqual } from 'node:util';
import tweetnacl from 'tweetnacl';
import fastify from 'fastify';
import { Server } from 'socket.io';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ClientToServerEvents, ServerToClientEvents } from '@/api/types';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { createCliApprovalsArtifactStore } from '@/session/actions/approvals/artifactStore';
import { registerApprovalRpcHandlers } from '@/rpc/handlers/approvals';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { handleActionsCommand } from '@/cli/commands/actions';
import { captureConsoleJsonOutput } from '@/testkit/logger/captureOutput';
import { createDaemonApprovalExecutionOriginCurrentness } from './daemonExternalActionTargetResolver';
import { createConnectedAccountPurposeBindingOwner } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { admitTargetActionApprovalTransition } from '@happier-dev/protocol/approvals/targetActionApprovalRequestTransition';

const externalActionTargetResolverMocks = vi.hoisted(() => ({
  fetchSessionById: vi.fn(),
  fetchAccountMachineReplacements: vi.fn(),
}));

vi.mock('@/session/transport/http/sessionsHttp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/session/transport/http/sessionsHttp')>()),
  fetchSessionById: externalActionTargetResolverMocks.fetchSessionById,
}));

vi.mock('@/api/machine/fetchAccountMachineReplacements', () => ({
  fetchAccountMachineReplacements: externalActionTargetResolverMocks.fetchAccountMachineReplacements,
}));

import {
  API_TOKEN_FULL_GRANT_V1,
  AccountApiTokenSummaryV1Schema,
  ActionsSettingsV1Schema,
  ApprovalExecutionOriginV1Schema,
  ExternalActionExecutionAuthorizationV1Schema,
  FeaturesResponseSchema,
  accountSettingsParse,
  ApiTokenGrantV1Schema,
  buildQualifiedPluginContributionKey,
  createPluginContributionIdentity,
  StrictJsonValueSchema,
  TargetActionApprovalRequestV1Schema,
  WorkflowRunSummaryV1Schema,
  WorkflowProgressEnvelopeV1Schema,
  WorkflowRunStartRequestV1Schema,
  WorkflowRunRecipientCensusResponseV1Schema,
  sealWorkflowAcceptedSnapshotStoredEnvelopeV1,
  sealWorkflowProgressStoredEnvelopeV1,
  serializeWorkflowStoredContentEnvelopeV1,
  openWorkflowAcceptedSnapshotStoredEnvelopeV1,
  parseWorkflowStoredContentEnvelopeV1,
  type ApprovalExecutionOriginV1,
  type PluginMachineExecutionOriginV1,
  type TargetActionApprovalReplayPlacementV1,
  type TargetActionApprovalRequestV1,
  type WorkflowDefinitionV1,
  type PluginActionContributionV2,
  type PluginHostAccessRequestV2,
  type PluginSourceCustodyV1,
} from '@happier-dev/protocol';
import {
  createActionExecutor,
  createTargetedActionRpcRequestV1,
  getActionSpec,
  signExternalActionApprovalInputV1,
  verifyExternalActionApprovalInputV1,
  type ActionExecutorDeps,
  createWorkflowAccountRunActionOwner,
  type WorkflowAccountRunActionDeps,
  type ActionExecutorContext,
} from '@happier-dev/protocol/actions';
import type {
  JsonValue,
  PluginInvocationContext,
} from '@happier-dev/plugin-sdk';
import { PluginError } from '@happier-dev/plugin-sdk';

import type { LoadedPlugin } from '@/plugins/discovery/load/installed';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import {
  createResolvedContributionRegistry,
} from '@/plugins/projection/registry/createResolvedContributionRegistry';
import {
  buildPluginContributionRegistry,
} from '@/plugins/projection/registry/normalize/package';
import type { ResolvedActionContribution } from '@/plugins/projection/registry/types';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller';
import { createPluginRuntimeOccurrenceId, type PluginRuntimeOccurrenceId } from '@/plugins/runtime/runtimeSlots';
import {
  createTargetActionHostBindingResolver,
  createTargetActionHostPolicyResolver,
} from '@/plugins/runtime/hostAccess/resolve';
import type { TargetActionCurrentIntentRequest } from '@/plugins/runtime/invocation/actionExecutor';
import { createTargetActionCurrentIntentAdapter } from '@/session/actions/approvals/targetActionCurrentIntent';
import { createTargetActionApprovalDecision } from '@happier-dev/protocol/actions/targetActionApprovalDecision';
import { getActiveAccountSettingsSnapshot, setActiveAccountSettingsSnapshot, clearActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import {
  buildTargetActionInvocationRegistry,
} from '@/plugins/runtime/invocation/buildTargetActionRegistry';
import {
  createUnavailablePluginServicesFactory,
} from '@/plugins/runtime/invocation/services/factory';
import { createProductionPluginInvocationServiceOwners } from '@/plugins/runtime/invocation/services/production';
import { createPluginActionCallerMaterializationFixture } from '@/plugins/runtime/invocation/services/actionCaller.testkit';
import {
  createUnavailablePluginServices,
} from '@/plugins/runtime/invocation/services/unavailable';
import { encryptSessionPayload } from '@/session/transport/encryption/sessionEncryptionContext';
import { encodeBase64 } from '@/api/encryption';
import { createPluginInvocationActionsService } from '@/plugins/runtime/invocation/services/actions';
import type { PluginActionsServiceSeed } from '@/plugins/runtime/invocation/services/actions';
import { createCliActionExecutor } from '@/session/actions/createCliActionExecutor';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import * as daemonControlClient from '@/daemon/controlClient';
import { createPluginActionExecutor } from '@/session/actions/createDaemonPluginActionExecutor';
import { createActionToolExecutorBridge } from '@/agent/tools/happierTools/createActionToolExecutorBridge';
import { dispatchBuiltInHappierTool } from '@/agent/tools/happierTools/dispatchBuiltInHappierTool';
import { executeContributedAction } from '@/plugins/runtime/invocation/actions/executeContributedAction';
import { setActionApprovalOverride } from '@happier-dev/protocol/actions/actionSettings';
import { getSharedBlockingApprovalCoordinator } from '@happier-dev/protocol/actions/blockingApprovalCoordinator';
import { resolveApprovalRequestApproveAdmission } from '@happier-dev/protocol/actions/actionApprovalPresentation';
import { formatQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { createCommittedContributedActionInvoker, createCommittedContributedActionSchemaReader } from '@/plugins/runtime/invocation/actions/createCommittedContributedActionDeps';
import { buildWorkflowActionContext } from '@/daemon/workflows/daemonRuntime';
import { projectOccurrenceBoundExecutablePluginToolCatalog } from '@/plugins/runtime/toolCatalog';
import { registerActionSpecRpcHandlers } from '@/rpc/handlers/registerActionSpecRpcHandlers';
import { createDaemonControlApp } from '@/daemon/controlServer';
import { materializeWorkflowAcceptedSnapshotV1 } from '@happier-dev/protocol/workflows/materializeWorkflowAcceptedSnapshotV1';
import { createWorkflowCoordinator } from '@/daemon/workflows/coordinator';
import { createInMemoryWorkflowCoordinatorStore } from '@/daemon/workflows/workflowCoordinator.testkit';
import { createWorkflowInvocationRecoveryObserver, observeWorkflowInvocationRecoveryEvidence } from '@/daemon/workflows/invocationRecoveryObserver';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { normalizePluginJsonSchema } from '@happier-dev/protocol/plugins/actions/protocol-composable-schema';
import { zodSchemaToJsonSchemaObject } from '@happier-dev/protocol/actions/actionInputJsonSchema';
import { invokeHostReviewedChildV1 } from '@happier-dev/protocol/actions/actionExecutor';
import { createDeploymentEnvironmentDetailV1, createDeploymentReceiptDetailV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { ProjectSourcesReadOutputV1Schema } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { createProjectAccountRowCipherV1 } from '@happier-dev/protocol/projects/projectAccountRowCipherV1';
import { retainVerifiedExternalActionRequester } from '@/daemon/agentIsolation/agentIsolationLaunchPolicy';
import { createFilesystemEffectAdmission } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemEffectAdmission';
import { readDeploymentSourceIntentForHost } from '@/deployments/readDeploymentSourceIntentForHost';
import { createPlainProjectAccountRefRow, mockProjectAccountRowsHttpBoundary } from '@/workspaces/projectAccountRows.testkit';
import { withdrawActiveProjectAccountRowsSnapshot } from '@/workspaces/projectAccountRows';

import {
  createDaemonExternalActionContributedApprovalReplay,
  createDaemonExternalActionContributedDefinitionLister,
  createDaemonExternalActionContributedInvoker,
} from './createDaemonExternalActionContributedInvoker';
import { createDaemonExternalActionTargetResolver } from './daemonExternalActionTargetResolver';
import { executeExternalAction } from './executeExternalAction';
import { isTriageHostActionCaller } from '../../../../../packages/plugins/triage/src/actions/callerSource';
import { readConversationSessionProjectionNoHistoryBaseline } from '../../../../../packages/plugins/channels/src/sessionProjection';
import { getSessionTranscript } from '@/session/services/getSessionTranscript';
import { createAccountEncryptionCurrentnessFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';

const EXTERNAL_ACTION_ENCRYPTION_KEY = new Uint8Array(32).fill(7);

function createApiActionApprovalOrigin(defaultSessionId?: string): ApprovalExecutionOriginV1 {
  return {
    v: 1,
    authority: 'account_automation',
    surface: 'api',
    caller: { kind: 'host' },
    serverId: 'server-external',
    accountId: 'account-1',
    principalId: 'principal-1',
    credentialId: '11111111-1111-4111-8111-111111111111',
    machineId: 'machine-local',
    ...(defaultSessionId ? { sessionId: defaultSessionId } : {}),
    target: { kind: 'machine', machineId: 'machine-local' },
    actionId: 'action.invoke',
    requestId: 'request-1',
  };
}

function createSharedBotContributedContext(sourceKind: 'pat' | 'session' = 'pat', workspaceWrites?: 'allow' | 'deny') {
  const installationKeyPair = tweetnacl.sign.keyPair();
  const target = { kind: 'machine' as const, machineId: 'machine-local' };
  const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-admitted-bot-action', binding: {
    serverIdentityId: 'server-external', accountId: 'alice', custodianAccountId: 'alice', installationId: 'bot-installation',
    machineId: 'machine-local', actionId: 'action.invoke', requestId: 'bot-action-request',
    requestEnvelopeDigest: 'A'.repeat(43), target,
    ...(sourceKind === 'pat' ? { principalId: 'alice-principal', credentialId: '11111111-1111-4111-8111-111111111111', grant: API_TOKEN_FULL_GRANT_V1 }
      : { authentication: { kind: 'account', tokenEpoch: 7 }, sessionActionOrigin: { v: 1,
          caller: { kind: 'session', sessionId: 'bot-session', starterDepth: 0, turnDepth: 0 },
          sourceTurnId: 'bot-turn', callerPermissionMode: 'yolo', requestId: 'bot-action-request',
          ...(workspaceWrites === undefined ? {} : { workspaceWrites }) },
          sessionActionSource: { machineId: 'machine-local', installationId: 'bot-installation' } }),
  } });
  const context: ActionExecutorContext = {
    surface: 'agent', authority: 'account_automation', serverId: 'server-external', serverIdentityId: 'server-external',
    runtimeAccountId: 'alice', defaultSessionId: 'bot-session', actionRequestId: 'bot-action-request',
    ...('grant' in authorization.binding ? { actionCaller: { kind: 'host' as const },
      externalActionCredential: { accountId: 'alice', principalId: 'alice-principal',
        credentialId: '11111111-1111-4111-8111-111111111111', grant: authorization.binding.grant } }
      : { actionCaller: authorization.binding.sessionActionOrigin!.caller,
          callerPermissionMode: 'yolo' as const,
          ...(workspaceWrites === undefined ? {} : { workspaceWrites }),
          sessionInputSource: { sourceSessionId: 'bot-session', sourceTurnId: 'bot-turn', via: 'action' as const } }),
    externalActionExecutionAuthorization: authorization, externalActionTarget: target,
    signExternalActionApprovalInput: ({ actionId, input, target: signedTarget, requesterConfirmation }) => signExternalActionApprovalInputV1({
      authorizationToken: authorization.token, actionId, input, target: signedTarget, privateKey: installationKeyPair.secretKey,
      ...(requesterConfirmation ? { requesterConfirmation } : {}),
    }),
  };
  const isApprovalExecutionOriginCurrent: NonNullable<Parameters<typeof createDaemonExternalActionContributedApprovalReplay>[0]['isApprovalExecutionOriginCurrent']> = async ({ origin, request }) => (
    origin.accountId === 'alice' && request?.v === 2 && origin.externalActionInputSignature !== undefined
    && origin.target !== undefined && origin.externalActionExecutionAuthorization !== undefined
    && verifyExternalActionApprovalInputV1({ authorizationToken: origin.externalActionExecutionAuthorization.token,
      actionId: origin.actionId, target: origin.target, input: request.actionArgs,
      ...(request.requesterConfirmation ? { requesterConfirmation: request.requesterConfirmation } : {}),
      publicKey: installationKeyPair.publicKey, signature: origin.externalActionInputSignature })
  );
  return { context, publicKey: installationKeyPair.publicKey, isApprovalExecutionOriginCurrent, readInstallationIdentity: () => ({ version: 1 as const, installationId: 'bot-installation', createdAt: 1,
    publicKey: encodeBase64(installationKeyPair.publicKey, 'base64url'), privateKey: encodeBase64(installationKeyPair.secretKey, 'base64url') }) };
}


function createExternalActionExecutor(
  invokeContributedAction: NonNullable<ActionExecutorDeps['invokeContributedAction']>,
  listContributedActionDefinitions?: ActionExecutorDeps['listContributedActionDefinitions'],
) {
  return createActionExecutor({
    invokeContributedAction,
    ...(listContributedActionDefinitions ? { listContributedActionDefinitions,
      readContributedActionSchemas: createCommittedContributedActionSchemaReader(listContributedActionDefinitions) } : {}),
    isActionApprovalRequired: () => false,
  } as unknown as ActionExecutorDeps);
}

function createCanonicalSessionTargetResolver(params: Readonly<{
  machineId?: string;
  host?: string;
  homeDir?: string;
}> = {}) {
  // The real Session transport checks Account currentness before opening owner metadata.
  vi.spyOn(axios, 'get').mockImplementation(async (url) => {
    if (!url.endsWith('/v1/account/encryption/currentness')) {
      throw new Error(`Unexpected external Action fixture GET: ${url}`);
    }
    return { status: 200, data: {
      mode: 'e2ee', version: 1,
      signingKeyFingerprint: 'a'.repeat(64),
      contentKeyFingerprint: 'b'.repeat(64),
      updatedAt: 1,
    } };
  });
  const machineId = params.machineId ?? 'machine-local';
  const host = params.host ?? 'host-local';
  const homeDir = params.homeDir ?? '/home/local';
  externalActionTargetResolverMocks.fetchSessionById.mockReset();
  externalActionTargetResolverMocks.fetchAccountMachineReplacements.mockReset();
  externalActionTargetResolverMocks.fetchAccountMachineReplacements.mockResolvedValue([]);
  externalActionTargetResolverMocks.fetchSessionById.mockResolvedValue({
    id: 'session-verified',
    seq: 1,
    createdAt: 1,
    updatedAt: 1,
    active: true,
    activeAt: 1,
    metadataVersion: 1,
    dataEncryptionKey: null,
    machineId: 'stale-raw-machine-id',
    encryptionMode: 'e2ee',
    metadata: encryptSessionPayload({
      ctx: {
        encryptionKey: EXTERNAL_ACTION_ENCRYPTION_KEY,
        encryptionVariant: 'legacy',
      },
      payload: {
        machineId,
        host,
        homeDir,
      },
    }),
  });
  return createDaemonExternalActionTargetResolver({
    credentials: {
      token: 'daemon-token',
      encryption: { type: 'legacy', secret: EXTERNAL_ACTION_ENCRYPTION_KEY },
    },
    currentMachineHost: 'host-local',
    currentMachineHomeDir: '/home/local',
  });
}

function createExternalActionIngressExecutor(scope: 'global' | 'session' = 'session') {
  const runtime = createExternalActionRuntime(scope);
  const lease: PluginRuntimeRegistryLease = {
    registry: runtime,
    source: 'ephemeral',
    durableRevision: runtime.durableRevision ?? -1,
    release: async () => {},
  };
  return createExternalActionExecutor(
    createDaemonExternalActionContributedInvoker({
      acquireRuntimeRegistryLease: async () => lease,
    }),
    createDaemonExternalActionContributedDefinitionLister({
      tryAcquireRuntimeRegistryLease: () => lease,
    }),
  );
}

describe('createDaemonExternalActionContributedInvoker', () => {
  it.each(['admitted', 'missing', 'other-account'] as const)('retains admitted Session targets through durable replay and nested child admission (%s)', async scenario => {
    const previousSettings = process.env.HAPPIER_ACTIONS_SETTINGS_V1;
    process.env.HAPPIER_ACTIONS_SETTINGS_V1 = JSON.stringify({ v: 1, actions: {
      'acme.managed/actions/inspect': { approvalRequiredSurfaces: ['cli'] },
    } });
    const address = { serverId: 'server-external', sessionId: 'admitted-session' };
    let seed: PluginActionsServiceSeed | undefined;
    let handlerCalls = 0;
    let childCalls = 0;
    let stored: TargetActionApprovalRequestV1 | null = null;
    // Only Home transport facts are supplied: the real executor owns target admission.
    const resolveSessionReference: NonNullable<ActionExecutorDeps['resolveSessionReference']> = async ({ sessionId }) => (
      sessionId === address.sessionId ? { kind: 'unique', address } : { kind: 'none' }
    );
    const runtime = createExternalActionRuntime('global', 'acme.managed', async context => {
      handlerCalls++;
      if (!seed) throw new Error('Expected real handler service seed');
      if (seed.contribution.id === 'actions/inspect') {
        childCalls++;
        expect(context.sessionTargetsV1).toMatchObject({ actionId: 'action.invoke', field: 'input.recipient.sessionId', targets: [address] });
        return;
      }
      expect(context.sessionTargetsV1).toEqual(stored?.executionOriginV1?.sessionTargetsV1);
      const actions = createPluginInvocationActionsService({ seed,
        actionExecutor: executor,
        invokeContributedAction: async () => { throw new Error('Unexpected non-executor dispatch'); },
      });
      const child = { pluginId: 'acme.managed', localId: 'actions/inspect' };
      const childInput = { recipient: { sessionId: address.sessionId } };
      // Routing evidence cannot supply an unadmitted address or override the child's operand.
      await expect(actions.execute(child, childInput, { sessionAddress: { ...address, sessionId: 'unadmitted' } }))
        .rejects.toMatchObject({ code: 'session_address_unsupported' });
      await expect(actions.execute(child, { recipient: { sessionId: 'unadmitted' } }, { sessionAddress: address }))
        .rejects.toMatchObject({ code: scenario === 'missing' ? 'session_address_unsupported' : 'session_address_mismatch' });
      if (scenario === 'missing') {
        await expect(actions.execute(child, childInput, { sessionAddress: address }))
          .rejects.toMatchObject({ code: 'session_address_unsupported' });
      } else {
        await actions.execute(child, childInput, { sessionAddress: address });
      }
    }, undefined, undefined, value => { seed = value; }, undefined, 'safe', undefined,
    { overlappingTool: true, surfaces: ['cli', 'plugin'],
      inputSchema: { type: 'object', properties: { recipient: { type: 'object', properties: { sessionId: { type: 'string' } }, required: ['sessionId'] } }, required: ['recipient'] },
      sessionTarget: { field: 'recipient.sessionId', cardinality: 'one' } });
    const lease: PluginRuntimeRegistryLease = { registry: runtime, source: 'ephemeral', durableRevision: -1, release: async () => {} };
    const invoker = createDaemonExternalActionContributedInvoker({ acquireRuntimeRegistryLease: async () => lease,
      requestCurrentIntent: createTargetActionCurrentIntentAdapter({
        create: async request => { stored = TargetActionApprovalRequestV1Schema.parse(JSON.parse(JSON.stringify(request))); return { artifactId: 'session-replay' }; },
        read: async () => stored,
      }),
    });
    const list = createDaemonExternalActionContributedDefinitionLister({ tryAcquireRuntimeRegistryLease: () => lease });
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(),
      listContributedActionDefinitions: list, readContributedActionSchemas: createCommittedContributedActionSchemaReader(list),
      resolveSessionReference, invokeContributedAction: invoker,
    });
    try {
      const actionInput = { recipient: { sessionId: address.sessionId } };
      const context: ActionExecutorContext = { surface: 'cli', authority: 'account_automation', actionCaller: { kind: 'host' },
        serverId: address.serverId, runtimeAccountId: 'account-1', expectedSessionAddress: address };
      const targets = await resolveActionSessionTargets({ ...createUnavailableActionTransportDeps(), resolveSessionReference }, {
        actionId: 'action.invoke', declaration: { field: 'input.recipient.sessionId', cardinality: 'one' },
        input: { input: actionInput }, context,
      });
      if (!targets || 'ok' in targets) throw new Error('Expected host Session admission');
      const { principalId: _principal, credentialId: _credential, ...hostOrigin } = createApiActionApprovalOrigin();
      const admitted = await invoker({ action: { pluginId: 'acme.managed', localId: 'inspect' }, input: actionInput,
        context: { ...context, sessionTargetsV1: targets },
        approvalExecutionOrigin: { ...hostOrigin, surface: 'cli', sessionTargetsV1: targets }, signal: new AbortController().signal });
      expect(admitted, JSON.stringify(admitted)).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
      expect(handlerCalls).toBe(0);
      if (!stored) throw new Error('Expected durable approval');
      const retained: TargetActionApprovalRequestV1 = stored;
      expect(retained.executionOriginV1?.sessionTargetsV1).toMatchObject({ targets: [address] });
      if (scenario === 'missing') {
        if (!retained.executionOriginV1) throw new Error('Expected retained origin');
        const { sessionTargetsV1: _targets, ...withoutTargets } = retained.executionOriginV1;
        stored = { ...retained, executionOriginV1: withoutTargets };
      }
      const replay = createDaemonExternalActionContributedApprovalReplay({ credentials: { token: 'fixture', encryption: null },
        acquireRuntimeRegistryLease: async () => lease,
        isApprovalExecutionOriginCurrent: createDaemonApprovalExecutionOriginCurrentness({
          accountId: scenario === 'other-account' ? 'account-2' : 'account-1', machineId: 'machine-local', serverId: address.serverId,
          resolveCurrentMachineExecutionOriginContext: async () => ({ machineId: 'machine-local', serverIdentityId: 'server-external' }),
          resolveTarget: createCanonicalSessionTargetResolver(),
          isAccountCurrent: async () => true, listAccountApiTokens: async () => { throw new Error('Host has no PAT'); },
        }),
        targetActionApprovals: { targetActionApprovalsGet: async () => stored,
          targetActionApprovalsUpdate: async ({ request }) => { stored = TargetActionApprovalRequestV1Schema.parse(JSON.parse(JSON.stringify(request))); return { ok: true }; } },
      });
      const result = await replay({ artifactId: 'session-replay', decision: 'approve', context: {
        // Decider-supplied targets must never replace the Artifact's admitted targets.
        sessionTargetsV1: { actionId: 'action.invoke', field: 'input.recipient.sessionId', selector: false, targets: [{ ...address, sessionId: 'unadmitted' }] },
      } });
      expect(result, JSON.stringify(result)).toMatchObject(scenario === 'other-account'
        ? { ok: false, errorCode: 'approval_stale' } : { ok: true, result: { status: 'executed', execution: { ok: true } } });
      expect(handlerCalls).toBe(scenario === 'other-account' ? 0 : scenario === 'missing' ? 1 : 2);
      expect(childCalls).toBe(scenario === 'admitted' ? 1 : 0);
    } finally {
      await runtime.dispose();
      if (previousSettings === undefined) delete process.env.HAPPIER_ACTIONS_SETTINGS_V1;
      else process.env.HAPPIER_ACTIONS_SETTINGS_V1 = previousSettings;
    }
  });

  it.each(['custodian', 'nested-custodian', 'foreign', 'agent', 'cloned', 'cloned-child'] as const)(
    'preserves replay requester custody through a reviewed Plugin Action source read (%s)', async scenario => {
      const environment = createDeploymentEnvironmentDetailV1();
      const sourceIntent = createDeploymentReceiptDetailV1().content.sourceIntent;
      if (sourceIntent.kind !== 'repository') throw new Error('Repository source fixture required');
      const accountId = scenario === 'foreign' ? 'member' : 'owner';
      const sourceAllowed = scenario === 'custodian' || scenario === 'nested-custodian';
      const installationKeyPair = tweetnacl.sign.keyPair();
      const target = { kind: 'machine' as const, machineId: 'machine-local' };
      const root = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'replayed-root', binding: {
        accountId, custodianAccountId: 'owner', serverIdentityId: 'server-external', machineId: target.machineId,
        installationId: 'installation', authentication: { kind: 'account', tokenEpoch: 1 }, accountEncryptionMode: 'plain',
        admittedMachineRole: 'use', actionId: 'deployments.deploy', requestId: 'source-request',
        requestEnvelopeDigest: 'a'.repeat(43), target,
      } });
      // Replay rehydrates its signed root through the ingress owner. Only HTTP
      // and Account-row storage are replaced below; child issuance, requester
      // selection, source admission and outer Plugin Action settlement stay real.
      const retained = retainVerifiedExternalActionRequester({ authorization: { ...root,
        requesterAccountProjection: { accountId, serverId: 'server-external', accountEncryptionMode: 'plain',
          projectAccountRowCipher: createProjectAccountRowCipherV1({ mode: 'plain' }), isCurrent: async () => true,
          readArtifact: async () => null },
        requesterHttpProjection: { accountId, serverId: 'server-external', serverIdentityId: 'server-external',
          serverHttpBaseUrl: 'https://source.test', accountEncryptionMode: 'plain', isCurrent: async () => true,
          createRequestHeaders: async () => ({ 'x-requester-proof': 'fixture' }) },
      }, isCurrent: async () => true });
      const authorization = scenario === 'cloned'
        ? Object.defineProperties({ ...retained }, Object.getOwnPropertyDescriptors(retained)) : retained;
      const rows = mockProjectAccountRowsHttpBoundary([createPlainProjectAccountRefRow({ id: 'workspace', serverId: 'server-external',
        machineId: target.machineId, rootPath: '/source-checkout', createdAtMs: 1,
        source: { sourceId: sourceIntent.projectSourceId, revision: sourceIntent.sourceRevision } })]);
      const sourceReads = vi.spyOn(axios, 'request').mockResolvedValue({ status: 200, data: ProjectSourcesReadOutputV1Schema.parse({ ok: true,
        canManage: true, source: { id: sourceIntent.projectSourceId, revision: sourceIntent.sourceRevision, name: 'App', audience: [],
          createdByAccountId: accountId, repository: { protocol: 'https', provider: { id: 'github', kind: 'github', displayName: 'GitHub',
            baseUrl: 'https://github.com' }, repository: { nameWithOwner: 'example/app', cloneUrl: 'https://github.com/example/app.git' } } } }) });
      const identityOwner = createFilesystemEffectAdmission({ resolveHomeServerIdentityId: async () => 'server-external',
        resolveHostIdentity: async () => ({ machineId: target.machineId, installationId: 'installation', custodianAccountId: 'owner' }) });
      let issuedContext: ActionExecutorContext | undefined;
      let invocationContext: ActionExecutorContext | undefined;
      let acquiredSource = false;
      const runtime = createExternalActionRuntime('global', 'acme.external', async () => {
        if (!invocationContext) throw new Error('Expected invocation approval context');
        const selected = await readDeploymentSourceIntentForHost({ request: { environment, sourceIntent, context: invocationContext }, host: {
          credentials: { token: 'owner-fixture', encryption: null }, serverId: 'server-external', serverHttpBaseUrl: 'https://source.test',
          machineId: target.machineId, async assertAuthority() {}, async resolveRequesterIdentity(current) {
            const requester = await identityOwner.resolveActionRequester!(current);
            try { return requester.identity; } finally { await requester.dispose(); }
          },
        } });
        expect(selected.workspace?.rootPath).toBe('/source-checkout');
        acquiredSource = true;
      }, undefined, undefined, seed => { invocationContext = seed.approvalContext; }, undefined, 'safe', undefined,
      { surfaces: ['cli', 'plugin'] });
      const lease: PluginRuntimeRegistryLease = { registry: runtime, source: 'ephemeral',
        durableRevision: runtime.durableRevision ?? -1, release: async () => {} };
      const invoke = createDaemonExternalActionContributedInvoker({ acquireRuntimeRegistryLease: async () => lease });
      const action = { pluginId: 'acme.external', localId: 'inspect' };
      try {
        const result = await invokeHostReviewedChildV1({ parent: { actionId: 'deployments.deploy', input: {} },
          context: { surface: 'cli', authority: 'account_automation', runtimeAccountId: accountId,
            serverId: 'server-external', serverIdentityId: 'server-external', actionRequestId: 'source-request',
            signExternalActionApprovalInput: ({ actionId, input, target, requesterConfirmation }) =>
              signExternalActionApprovalInputV1({ authorizationToken: root.token, actionId, input, target,
                ...(requesterConfirmation ? { requesterConfirmation } : {}), privateKey: installationKeyPair.secretKey }),
            actionCaller: scenario === 'agent' ? { kind: 'session', sessionId: 'owner-agent', starterDepth: 0, turnDepth: 0 } : { kind: 'host' },
            externalActionTarget: target, externalActionExecutionAuthorization: authorization },
          child: { action, role: 'deploy', input: {} }, admittedReview: { action, role: 'deploy', surface: 'cli' },
          execute: async (input, context) => {
            if (scenario === 'nested-custodian') return invokeHostReviewedChildV1({
              parent: { actionId: 'deployments.deploy', input: {} }, context,
              child: { action, role: 'deploy', input: {} }, admittedReview: { action, role: 'deploy', surface: 'cli' },
              execute: async (_input, nested) => { issuedContext = nested; return invoke({ action, input: {}, context: nested }); },
            });
            const childAuthorization = context.externalActionExecutionAuthorization;
            issuedContext = scenario === 'cloned-child' && childAuthorization ? { ...context,
              externalActionExecutionAuthorization: Object.defineProperties({ ...childAuthorization },
                Object.getOwnPropertyDescriptors(childAuthorization)) } : context;
            return invoke({ action, input: {}, context: issuedContext });
          },
        });
        expect(result, JSON.stringify(result)).toMatchObject(sourceAllowed ? { ok: true } : {
          ok: false, errorCode: 'agent_isolation_unavailable',
          details: { retryable: false, details: { phase: 'deployment_source_admission', reason: scenario.startsWith('cloned')
            ? 'requester_authority_unavailable' : 'requester_workspace_requires_owner',
            requiredFact: scenario.startsWith('cloned') ? 'verified_root_requester' : 'unrestricted_workspace_requester',
            remedy: scenario.startsWith('cloned') ? 'retry_original_request' : 'run_from_authorized_host' },
            ...(scenario.startsWith('cloned') ? { remediation: { kind: 'retry' } } : {}) },
        });
        expect(acquiredSource).toBe(sourceAllowed);
        if (!sourceAllowed) { expect(rows).not.toHaveBeenCalled(); expect(sourceReads).not.toHaveBeenCalled(); }
      } finally { withdrawActiveProjectAccountRowsSnapshot(); vi.restoreAllMocks(); }
    });
  afterEach(() => { vi.restoreAllMocks(); });

  it.each([
    { requester: 'unknown', waive: false },
    { requester: 'bob', waive: false },
    { requester: 'absent', waive: false },
    { requester: 'bob', waive: true },
    { requester: 'unknown', waive: true },
    { requester: 'absent', waive: false, retiredDuringApproval: true },
  ] as const)('preserves requester consent through public Account-target action.invoke ($requester, waive=$waive)', async (scenario) => {
    const { requester, waive } = scenario;
    const retiredDuringApproval = 'retiredDuringApproval' in scenario;
    const previousSettings = getActiveAccountSettingsSnapshot();
    setActiveAccountSettingsSnapshot({ source: 'cache', settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [],
      settings: accountSettingsParse({ actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1,
        ...(waive ? { approvalWaivedSurfaces: { 'acme.account/actions/inspect': ['agent'] } } : {}),
      }) }) });
    const controller = new AbortController();
    const source = createSharedBotContributedContext('session');
    let effects = 0;
    const runtime = createExternalActionRuntime('session', 'acme.account', () => { effects += 1; },
      undefined, () => null, undefined, undefined, 'writesRemote', undefined, { surfaces: ['agent'], executionTarget: 'account' });
    const row: { request: TargetActionApprovalRequestV1 | null } = { request: null };
    let notifyCreated!: () => void;
    const created = new Promise<void>(resolve => { notifyCreated = resolve; });
    const update = async ({ request }: { request: TargetActionApprovalRequestV1 }) => {
      if (!row.request) throw new Error('Missing approval');
      const admission = admitTargetActionApprovalTransition(row.request, request);
      if (!admission.ok) return admission;
      row.request = TargetActionApprovalRequestV1Schema.parse(request);
      return { ok: true as const };
    };
    // The Account source's Home read: the census admitted this release, so it
    // runs again only when a person's approval wait crossed a later boundary.
    const revalidateAccountExecution = vi.fn(async () => !retiredDuringApproval);
    const lease: PluginRuntimeRegistryLease = { registry: { ...runtime, revalidateAccountExecution }, source: 'committed', durableRevision: 1, release: async () => {} };
    const list = createDaemonExternalActionContributedDefinitionLister({ tryAcquireRuntimeRegistryLease: () => lease });
    const invoke = createCommittedContributedActionInvoker({ acquireRuntimeRegistryLease: async () => lease,
      requestCurrentIntent: createTargetActionCurrentIntentAdapter({
        create: async request => { row.request = TargetActionApprovalRequestV1Schema.parse(request); notifyCreated(); return { artifactId: 'account-write' }; },
        read: async () => row.request, update,
      }) });
    const actionInput = { action: { pluginId: 'acme.account', localId: 'inspect' }, input: {} };
    const pending = createExternalActionExecutor(invoke, list).execute('action.invoke', actionInput, {
      ...source.context, signal: controller.signal,
      ...(requester === 'absent' ? {} : { actionRequestAttributionV1: { requestRef: 'account-request',
        requester: requester === 'bob' ? { serverId: 'server-external', accountId: 'bob' } : null,
        persona: { serverId: 'server-external', sessionId: 'bot-session' }, origin: null } }),
    });
    try {
      const first = await Promise.race([created.then(() => ({ created: true as const })),
        pending.then(result => ({ created: false as const, result }))]);
      if (waive || requester === 'unknown') {
        expect(first).toMatchObject({ created: false, result: waive ? { ok: true }
          : { ok: false, errorCode: 'approval_requester_unavailable' } });
        expect(row.request).toBeNull();
        expect(effects).toBe(waive ? 1 : 0);
        expect(revalidateAccountExecution).toHaveBeenCalledTimes(0);
        return;
      }
      expect(first).toEqual({ created: true });
      expect(row.request?.replayPlacement).toBeUndefined();
      await vi.waitFor(() => expect(getSharedBlockingApprovalCoordinator().getLiveWaiterCount('account-write')).toBe(1));
      const decide = createTargetActionApprovalDecision({ read: async () => row.request, update, hasLiveInvocation: () => true,
        isRequesterSourceCurrent: async request => {
          const origin = request.executionOriginV1;
          return Boolean(origin?.externalActionExecutionAuthorization && origin.target && origin.externalActionInputSignature
            && verifyExternalActionApprovalInputV1({ authorizationToken: origin.externalActionExecutionAuthorization.token,
              actionId: 'action.invoke', target: origin.target, input: actionInput,
              requesterConfirmation: request.requesterConfirmation, publicKey: source.publicKey, signature: origin.externalActionInputSignature }));
        } });
      const ownerContext: ActionExecutorContext = { surface: 'ui', authority: 'present_user', runtimeAccountId: 'alice' };
      const ownerDecision = await decide({ artifactId: 'account-write', decision: 'approve', context: ownerContext });
      if (requester === 'bob') {
        expect(ownerDecision).toMatchObject({ ok: false, errorCode: 'present_user_required' });
        expect(row.request).toMatchObject({ status: 'open', approvalInputCustody: 'live_only',
          requesterConfirmation: { requesterAccountId: 'bob', executionAccountId: 'alice' },
          executionOriginV1: { accountId: 'alice', actionRequestAttributionV1: { requester: { accountId: 'bob' } } } });
        expect(effects).toBe(0);
      } else expect(ownerDecision).toMatchObject({ ok: true });
      const context: ActionExecutorContext = requester === 'bob' ? { ...ownerContext, requesterApprovalDecision: {
        sessionId: 'bot-session', actor: { kind: 'accountUser', accountId: 'bob', relationship: 'sharedApprover' },
        isCurrent: async () => true,
      } } : ownerContext;
      if (requester === 'bob') expect(await decide({ artifactId: 'account-write', decision: 'approve', context }))
        .toMatchObject({ ok: true });
      if (retiredDuringApproval) {
        expect(await pending).toMatchObject({ ok: false, errorCode: 'plugin_action_generation_retired' });
        expect(effects).toBe(0);
        return;
      }
      expect(await pending).toMatchObject({ ok: true });
      expect(revalidateAccountExecution).toHaveBeenCalledTimes(1);
      expect(row.request).toMatchObject({ status: 'executed', execution: { ok: true, effectAttempted: true } });
      expect(effects).toBe(1);
      expect(await decide({ artifactId: 'account-write', decision: 'approve', context }))
        .toMatchObject({ ok: true, result: { status: 'executed', execution: { ok: true } } });
      expect(effects).toBe(1);
    } finally {
      controller.abort();
      await pending.catch(() => undefined);
      await runtime.dispose();
      if (previousSettings) setActiveAccountSettingsSnapshot(previousSettings);
      else clearActiveAccountSettingsSnapshot();
    }
  });

  it.each(['current', 'wrong-home', 'stale-source', 'live-only'] as const)('decides target approvals through the real CLI and exact daemon (%s)', async mode => {
    const scratch = await mkdtemp(join(tmpdir(), 'happier-fx45-'));
    const effectPath = join(scratch, 'target-effect.json');
    const token = `fixture.${Buffer.from(JSON.stringify({ sub: 'account-1', session: 'terminal', tokenEpoch: 7,
      provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`;
    const credentials = { token, encryption: null, credentialProvenance: 'stored_session' } as const;
    const app = fastify();
    const sockets = new Server<ClientToServerEvents, ServerToClientEvents>(app.server, { path: '/v1/updates' });
    const rows = new Map<string, Record<string, unknown>>();
    const calls: string[] = [];
    const packets: unknown[] = [];
    const features = FeaturesResponseSchema.parse({ features: {},
      capabilities: { serverIdentity: { serverIdentityId: mode === 'wrong-home' ? 'srv_wrong_fx45' : 'srv_fx45' } } });
    app.get('/v1/features', async () => features);
    app.get('/v1/features/authenticated', async request => {
      expect(request.headers.authorization).toBe(`Bearer ${token}`);
      return features;
    });
    app.get('/v1/account/encryption', async () => ({ mode: 'plain', updatedAt: 1 }));
    app.get('/v1/account/profile', async () => ({ id: 'account-1' }));
    app.get('/v1/machines/machine-local', async () => ({ machine: { id: 'machine-local', active: true,
      kind: 'persistent', storageMode: 'plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
      revokedAt: null, replacedByMachineId: null } }));
    app.get<{ Params: { id: string } }>('/v1/artifacts/:id', async (request, reply) =>
      rows.get(request.params.id) ?? reply.code(404).send({ error: 'not_found' }));
    app.post<{ Body: { id: string; header: string; body: string; dataEncryptionKey: string } }>('/v1/artifacts', async request => {
      const row = { ...request.body, ownerAccountId: 'account-1', access: 'owner', encryptionMode: 'plain',
        headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
      rows.set(row.id, row);
      return row;
    });
    app.post<{ Params: { id: string }; Body: { header: string; body: string; expectedHeaderVersion: number;
      expectedBodyVersion: number } }>('/v1/artifacts/:id', async request => {
      const previous = rows.get(request.params.id)!;
      expect(request.body.expectedHeaderVersion).toBe(previous.headerVersion);
      expect(request.body.expectedBodyVersion).toBe(previous.bodyVersion);
      const row = { ...previous, header: request.body.header, body: request.body.body,
        headerVersion: request.body.expectedHeaderVersion + 1, bodyVersion: request.body.expectedBodyVersion + 1 };
      rows.set(request.params.id, row);
      return { success: true, headerVersion: row.headerVersion, bodyVersion: row.bodyVersion };
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture Home');
    const serverApiUrl = `http://127.0.0.1:${address.port}`;
    let effects = 0;
    const runtime = createExternalActionRuntime('global', 'acme.external', async () => {
      effects++;
      await writeFile(effectPath, JSON.stringify({ applied: true }));
    }, undefined, () => ({ serverId: 'server-external', machineId: 'machine-local' }), undefined,
    undefined, 'writesRemote', undefined, { surfaces: ['cli'] });
    const lease = { registry: runtime, source: 'ephemeral' as const,
      durableRevision: runtime.durableRevision ?? -1, release: async () => {} };
    const store = createCliApprovalsArtifactStore({ credentials, serverId: 'server-external', serverHttpBaseUrl: serverApiUrl });
    const replay = createDaemonExternalActionContributedApprovalReplay({ credentials,
      acquireRuntimeRegistryLease: async () => lease, targetActionApprovals: store,
      isApprovalExecutionOriginCurrent: createDaemonApprovalExecutionOriginCurrentness({
        accountId: 'account-1', machineId: 'machine-local', serverId: 'server-external',
        // Installed Machine/Home observation is an OS boundary; the real origin,
        // target and Account admission logic below remains in the currentness owner.
        resolveCurrentMachineExecutionOriginContext: async () => ({ machineId: 'machine-local',
          serverIdentityId: mode === 'wrong-home' ? 'srv_wrong_fx45'
            : mode === 'stale-source' ? 'srv_retired_fx45' : 'srv_fx45' }),
        resolveTarget: createDaemonExternalActionTargetResolver({ credentials, serverApiUrl }),
        isAccountCurrent: async () => (await axios.get<{ id: string }>(`${serverApiUrl}/v1/account/profile`)).data.id === 'account-1',
        listAccountApiTokens: async () => { throw new Error('Ordinary CLI source has no PAT'); },
      }) });
    const daemon = createActionExecutor({ ...createUnavailableActionTransportDeps(),
      targetActionApprovalReplay: replay });
    const handlers = new Map<string, (input: unknown, context?: import('@/api/rpc/types').RpcHandlerContext) => Promise<unknown>>();
    registerApprovalRpcHandlers({ actionExecutor: daemon,
      rpcHandlerManager: { registerHandler: (method, handler) => { handlers.set(method, handler); } } });
    sockets.on('connection', socket => {
      expect(socket.handshake.auth.token).toBe(token);
      socket.on(SOCKET_RPC_EVENTS.CALL, async (packet, acknowledge) => {
        calls.push(packet.method);
        packets.push(packet.params);
        const method = packet.method.replace('machine-local:', '');
        const handler = handlers.get(method);
        if (!handler) return acknowledge({ ok: false, error: 'method_not_found' });
        const result = await runWithServerHttpBaseUrl(serverApiUrl,
          () => handler(packet.params, { callerAuthority: 'present_user' }));
        acknowledge({ ok: true, result });
      });
    });
    try { await runWithServerHttpBaseUrl(serverApiUrl, async () => {
      const invoke = createDaemonExternalActionContributedInvoker({ acquireRuntimeRegistryLease: async () => lease,
        requestCurrentIntent: createTargetActionCurrentIntentAdapter({
          // Seed detached live-custody history at initial creation; custody
          // cannot be changed by an Artifact transition after admission.
          create: request => store.targetActionApprovalsCreate({ request: mode === 'live-only'
            ? TargetActionApprovalRequestV1Schema.parse({ ...request, approvalInputCustody: 'live_only' }) : request }),
          read: artifactId => store.targetActionApprovalsGet({ artifactId }),
        }) });
      const { principalId: _principal, credentialId: _credential, ...ordinaryOrigin } = createApiActionApprovalOrigin();
      const created = await invoke({ action: { pluginId: 'acme.external', localId: 'inspect' }, input: {},
        approvalExecutionOrigin: { ...ordinaryOrigin, serverIdentityId: 'srv_fx45',
          surface: 'cli', authority: 'present_user' }, context: { surface: 'cli', authority: 'present_user',
          actionCaller: { kind: 'host' } } });
      expect(created, JSON.stringify(created)).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
      const artifactId = [...rows.keys()][0]!;
      expect(await store.targetActionApprovalsGet({ artifactId })).toMatchObject({ status: 'open' });
      if (mode === 'live-only') expect(await store.targetActionApprovalsGet({ artifactId })).toMatchObject({
        approvalInputCustody: 'live_only', replayPlacement: { serverId: 'server-external', machineId: 'machine-local' },
      });
      const standalone = createCliActionExecutorFromCredentials({ credentials, serverId: 'deciding-device', serverApiUrl,
        actionsSettingsProvider: createActionSettingsProvider() });
      for (const surface of ['mcp', 'agent'] as const) {
        expect(await standalone.execute('approval.request.decide', { artifactId, decision: 'approve' }, {
          surface, authority: 'account_automation', actionCaller: { kind: 'session', sessionId: 'requesting-agent' },
        })).toMatchObject({ ok: false });
      }
      expect(calls).toEqual([]);
      expect(await store.targetActionApprovalsGet({ artifactId })).toMatchObject({ status: 'open' });
      const output = captureConsoleJsonOutput();
      try {
        await runWithServerHttpBaseUrl(serverApiUrl, () => handleActionsCommand(
          ['invoke', 'approval.request.decide', '--input-json', JSON.stringify({ artifactId, decision: 'approve' }), '--json'],
          { readCredentialsFn: async () => credentials, getServerProfileFn: async () => { throw new Error('No ambient profile'); },
            createExecutorFn: params => createCliActionExecutorFromCredentials({ ...params,
              serverId: 'deciding-device', serverApiUrl,
              actionsSettingsProvider: createActionSettingsProvider(),
            }) },
        ));
        const result = output.json();
        expect(result, JSON.stringify(result)).toMatchObject(mode !== 'current'
          ? { ok: false, error: { code: 'approval_stale' } }
          : { ok: true, data: { status: 'executed' } });
      } finally { output.restore(); process.exitCode = 0; }
      const settled = await store.targetActionApprovalsGet({ artifactId });
      expect(settled).toMatchObject({ status: mode === 'wrong-home' || mode === 'live-only' ? 'open' : mode === 'stale-source' ? 'failed' : 'executed' });
      expect(effects).toBe(mode === 'current' ? 1 : 0);
      expect(calls).toEqual(mode === 'wrong-home' ? [] : [`machine-local:${RPC_METHODS.APPROVAL_REQUEST_DECIDE}`]);
      expect(packets).toEqual(mode === 'wrong-home' ? [] : [{ artifactId, decision: 'approve',
        serverIdentityId: 'srv_fx45', originServerId: 'server-external' }]);
      if (mode === 'current') expect(JSON.parse(await readFile(effectPath, 'utf8'))).toEqual({ applied: true });
    });
    } finally {
      await runtime.dispose();
      await new Promise<void>(resolve => sockets.close(() => resolve()));
      await app.close();
      await rm(scratch, { recursive: true, force: true });
    }
  });

  it.each(['pat', 'session'] as const)('retains signed %s source custody through nested production services', async sourceKind => {
    const source = createSharedBotContributedContext(sourceKind);
    let approval: unknown;
    let effects = 0;
    const executor = createActionExecutor({
      ...createUnavailableActionTransportDeps(),
      isActionApprovalRequired: () => false,
      approvalsCreate: async ({ request }) => { approval = request; return { artifactId: 'signed-nested-preview' }; },
      sessionSendMessage: async () => { effects++; return { status: 'accepted', localId: 'effect' }; },
    });
    const owners = createProductionPluginInvocationServiceOwners({ actionExecutor: executor,
      invokeContributedAction: async () => { throw new Error('No contributed effect expected'); } });
    const id = `nested-${sourceKind}`;
    const services = owners.createServices({ plugin: { id: 'acme.external', version: '1.0.0' },
      resolveCurrentPluginMaterializationRef: createPluginActionCallerMaterializationFixture('acme.external', { machineId: 'machine-local' }).resolveCurrentPluginMaterializationRef,
      contribution: { id: 'inspect', qualifiedId: 'acme.external/actions/inspect' },
      occurrenceId: id, correlationId: id, surface: 'plugin', session: { id: 'bot-session' },
      sourceCustody: { kind: 'development', registeredRootId: 'fixture-root:acme.external' },
      approvalContext: { ...source.context, actionRequestAttributionV1: { requestRef: 'bob-input',
        requester: { serverId: 'server-external', accountId: 'bob' },
        persona: { serverId: 'server-external', sessionId: 'original-manager-session' }, origin: null } },
      signal: new AbortController().signal, isOccurrenceCurrent: () => true,
    }, owners.createOrdinaryServiceBinding(id, id));
    try {
      await services.actions.execute('session.message.send', {
        sessionId: 'bot-session', message: 'Review this update', idempotencyKey: id,
      });
      expect(approval).toMatchObject({ requesterConfirmation: { requesterAccountId: 'bob', executionAccountId: 'alice',
          personaSessionRef: { serverId: 'server-external', sessionId: 'bot-session' } },
        executionOriginV1: { accountId: 'alice', caller: { kind: 'plugin', pluginId: 'acme.external' },
          actionRequestAttributionV1: { persona: { sessionId: 'original-manager-session' } },
          externalActionExecutionAuthorization: source.context.externalActionExecutionAuthorization } });
      expect(effects).toBe(0);
    } finally { await owners.dispose(); }
  });

  it.each([
    { liveOnly: false, outcome: 'executed', lostDecisionRead: false },
    { liveOnly: false, outcome: 'executed', lostDecisionRead: true },
    { liveOnly: true, outcome: 'executed', lostDecisionRead: false },
    { liveOnly: true, outcome: 'failed', lostDecisionRead: false },
    { liveOnly: true, outcome: 'uncertain', lostDecisionRead: false },
    { liveOnly: true, outcome: 'receipt_unknown', lostDecisionRead: false },
  ] as const)('settles a shared contributed approval with the credential admitted through its real Plugin service (liveOnly=$liveOnly, outcome=$outcome, lostDecisionRead=$lostDecisionRead)', async ({ liveOnly, outcome, lostDecisionRead }) => {
    const source = createSharedBotContributedContext('session');
    const service = { pluginId: 'acme.external', localId: 'credentials' };
    const purpose = { consumer: { pluginId: 'acme.external', localId: 'inspect' }, purpose: 'release' };
    const account = { service, accountId: 'private-connected-profile' };
    let materializations = 0;
    const credentialOwner = createConnectedAccountPurposeBindingOwner({
      credentialOwnerAccountId: 'alice',
      store: {
        read: async () => ({ v: 1, bindings: [{ purpose, target: { kind: 'account', account } }] }),
        update: async () => { throw new Error('Replay cannot change the saved credential'); },
        subscribe: () => ({ dispose() {} }),
      },
      selectTarget: async () => { throw new Error('No credential prompt during replay'); },
      resolveTarget: async target => target.kind === 'account' ? { account: target.account, displayName: 'Release GitHub' } : null,
      materializeAccount: async () => {
        materializations += 1;
        return { kind: 'environment', env: { RELEASE_TOKEN: 'private-release-token' } };
      },
      projectTargetAccounts: async () => { throw new Error('No account listing'); },
      assertTargetAccountMaterializable: async () => { throw new Error('No listed account selection'); },
    });
    const owners = createProductionPluginInvocationServiceOwners({ connectedAccounts: credentialOwner });
    const controller = new AbortController();
    const secret = 'private-live-release-input';
    let effects = 0;
    const runtime = createExternalActionRuntime('global', 'acme.external', async context => {
      const material = await context.services.connectedAccounts.materialize('release', { kind: 'environment', keys: ['RELEASE_TOKEN'] });
      expect(material).toEqual({ kind: 'environment', env: { RELEASE_TOKEN: 'private-release-token' } });
      effects += 1;
      if (outcome === 'failed') throw new PluginError({ code: 'release_refused', message: secret });
      if (outcome === 'uncertain') controller.abort();
    }, undefined, undefined, undefined, owners, 'writesRemote', undefined, { surfaces: ['agent'], hostAccess: [{
      id: 'release', capability: 'connectedAccounts', reason: 'Publish the approved release',
      scope: { serviceRefs: ['credentials'], operations: ['use'], materializationKinds: ['environment'] },
    }], ...(liveOnly ? {
      inputSchema: { type: 'object', properties: { title: { type: 'string' }, token: { type: 'string' } },
        required: ['title', 'token'], additionalProperties: false },
      inputHints: { fields: [{ path: 'token', title: 'Release credential', widget: 'secret' }] },
    } : {}) });
    const lease: PluginRuntimeRegistryLease = { registry: runtime, source: 'ephemeral',
      durableRevision: runtime.durableRevision ?? -1, release: async () => {} };
    let stored: TargetActionApprovalRequestV1 | null = null;
    const invoker = createDaemonExternalActionContributedInvoker({ acquireRuntimeRegistryLease: async () => lease,
      requestCurrentIntent: createTargetActionCurrentIntentAdapter({
        create: async request => { stored = TargetActionApprovalRequestV1Schema.parse(request); return { artifactId: 'credential-write' }; },
        read: async () => stored,
        update: async ({ request }) => {
          if (!stored) throw new Error('Missing admitted approval');
          const transition = admitTargetActionApprovalTransition(stored, request);
          if (!transition.ok) return transition;
          stored = TargetActionApprovalRequestV1Schema.parse(request);
          if (outcome === 'receipt_unknown' && request.execution !== undefined) throw new Error('Receipt acknowledgement lost');
          return { ok: true };
        },
      }),
    });
    const attribution = { requestRef: 'bob-original-request', requester: { serverId: 'server-external', accountId: 'bob' },
      persona: { serverId: 'server-external', sessionId: 'original-manager-session' }, origin: null };
    try {
      const pending = createExternalActionExecutor(invoker).execute('action.invoke', {
        action: { pluginId: 'acme.external', localId: 'inspect' }, input: { title: 'Approved release', ...(liveOnly ? { token: secret } : {}) },
      }, { ...source.context, signal: controller.signal, actionRequestAttributionV1: attribution });
      if (liveOnly) await vi.waitFor(() => expect(getSharedBlockingApprovalCoordinator().getLiveWaiterCount('credential-write')).toBe(1));
      else expect(await pending).toMatchObject({ ok: true, result: { kind: 'approval_request_created', artifactId: 'credential-write' } });
      expect(materializations).toBe(0);
      let readUnavailable = lostDecisionRead;
      let decisionWrites = 0;
      const replay = createDaemonExternalActionContributedApprovalReplay({
        readInstallationIdentity: source.readInstallationIdentity,
        credentials: { token: 'alice-token', encryption: null } as never,
        isApprovalExecutionOriginCurrent: source.isApprovalExecutionOriginCurrent,
        acquireRuntimeRegistryLease: async () => lease,
        targetActionApprovals: {
          targetActionApprovalsGet: async () => {
            if (readUnavailable && stored?.status === 'approved') throw new Error('Artifact storage temporarily unavailable');
            return stored;
          },
          targetActionApprovalsUpdate: async ({ request }) => {
            if (request.status === 'approved') decisionWrites++;
            const transition = stored && admitTargetActionApprovalTransition(stored, request);
            if (transition && !transition.ok) return transition;
            stored = TargetActionApprovalRequestV1Schema.parse(request);
            return { ok: true };
          },
        },
      });
      const context: ActionExecutorContext = { surface: 'ui', authority: 'present_user', runtimeAccountId: 'alice',
        requesterApprovalDecision: { sessionId: 'bot-session',
          actor: { kind: 'accountUser', accountId: 'bob', relationship: 'sharedApprover' }, isCurrent: async () => true } };
      if (lostDecisionRead) {
        await expect(replay({ artifactId: 'credential-write', decision: 'approve', context }))
          .resolves.toMatchObject({ ok: false, errorCode: 'approval_context_unavailable' });
        expect(stored).toMatchObject({ status: 'approved', decision: { kind: 'approve' } });
        expect(TargetActionApprovalRequestV1Schema.parse(stored).execution).toBeUndefined();
        expect(effects).toBe(0);
        expect(materializations).toBe(0);
        readUnavailable = false;
      }
      const result = await replay({ artifactId: 'credential-write', decision: 'approve', context });
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { status: liveOnly ? 'approved' : 'executed' } });
      if (liveOnly) expect(await pending).toMatchObject(outcome === 'executed' ? { ok: true }
        : { ok: false, errorCode: outcome === 'failed' ? 'release_refused'
          : outcome === 'receipt_unknown' ? 'approval_execution_outcome_unknown' : 'plugin_action_outcome_unknown' });
      expect(effects).toBe(1);
      expect(materializations).toBe(1);
      const operationCredentialUses = [{ v: 1, kind: 'connected_account', label: 'Release GitHub',
        owner: { kind: 'account', accountId: 'alice' }, service,
        why: { kind: 'purpose_binding', purpose, target: 'account' }, currentness: { kind: 'current_at_materialization' } }];
      const executed = outcome === 'executed' || outcome === 'receipt_unknown';
      const status = outcome === 'uncertain' ? 'outcome_unknown' : executed ? 'executed' : 'failed';
      expect(stored).toMatchObject({ status, decision: { decidingAccountId: 'bob' },
        executionOriginV1: { accountId: 'alice', actionRequestAttributionV1: attribution },
        execution: { ok: executed, operationCredentialUses,
          ...(executed ? {} : { errorCode: outcome === 'failed' ? 'release_refused' : 'approval_execution_outcome_unknown' }) } });
      const reader = createActionExecutor({ ...createUnavailableActionTransportDeps(), approvalsGet: async () => stored });
      const receipt = await reader.execute('approval.request.get', { artifactId: 'credential-write' }, {
        surface: 'cli', authority: 'account_automation', actionCaller: { kind: 'host' },
      });
      expect(receipt).toMatchObject({ ok: true, result: { request: { status,
        execution: { ok: executed, operationCredentialUses } } } });
      if (!liveOnly) expect(result).toMatchObject({ result: { execution: { operationCredentialUses } } });
      const repeated = await replay({ artifactId: 'credential-write', decision: 'approve', context });
      if (status === 'outcome_unknown') {
        expect(repeated).toMatchObject({ ok: false, errorCode: 'approval_execution_outcome_unknown' });
      } else {
        expect(repeated).toMatchObject({ ok: true, result: { status, execution: { operationCredentialUses } } });
      }
      expect(materializations).toBe(1);
      expect(effects).toBe(1);
      for (const privateValue of [secret, 'private-release-token', 'private-connected-profile']) {
        expect(JSON.stringify(stored)).not.toContain(privateValue);
        expect(JSON.stringify(result)).not.toContain(privateValue);
        expect(JSON.stringify(receipt)).not.toContain(privateValue);
      }
      if (lostDecisionRead) expect(decisionWrites).toBe(1);
    } finally {
      await owners.dispose();
    }
  });

  it('rechecks the live requester after confirming confidential contributed operands', async () => {
    const source = createSharedBotContributedContext();
    const controller = new AbortController();
    let effects = 0;
    let entitled = true;
    let stored: TargetActionApprovalRequestV1 | null = null;
    const runtime = createExternalActionRuntime('global', 'acme.external', () => { effects++; },
      undefined, undefined, undefined, undefined, 'writesRemote', undefined, {
        inputSchema: { type: 'object', properties: { token: { type: 'string' } }, required: ['token'], additionalProperties: false },
        surfaces: ['agent'], inputHints: { fields: [{ path: 'token', title: 'Token', widget: 'secret' }] },
      });
    const lease: PluginRuntimeRegistryLease = { registry: runtime, source: 'ephemeral',
      durableRevision: runtime.durableRevision ?? -1, release: async () => {} };
    const executor = createExternalActionExecutor(createDaemonExternalActionContributedInvoker({
      acquireRuntimeRegistryLease: async () => lease,
      requestCurrentIntent: createTargetActionCurrentIntentAdapter({
        create: async request => { stored = TargetActionApprovalRequestV1Schema.parse(request); return { artifactId: 'bob-confidential' }; },
        read: async () => stored,
        update: async ({ request }) => { stored = TargetActionApprovalRequestV1Schema.parse(request); return { ok: true }; },
      }),
    }));
    const pending = executor.execute('action.invoke', { action: { pluginId: 'acme.external', localId: 'inspect' },
      input: { token: 'synthetic-confidential-operand' } }, {
      ...source.context,
      signal: controller.signal,
      actionRequestAttributionV1: { requestRef: 'bob-secret-request', requester: { serverId: 'server-external', accountId: 'bob' },
        persona: { serverId: 'server-external', sessionId: 'bot-session' }, origin: null },
    });
    try {
    await vi.waitFor(() => expect(stored).not.toBeNull());
    expect(stored).toMatchObject({ approvalInputCustody: 'live_only', requesterConfirmation: { requesterAccountId: 'bob' } });
    expect(JSON.stringify(stored)).not.toContain('synthetic-confidential-operand');
    const replay = createDaemonExternalActionContributedApprovalReplay({
      readInstallationIdentity: source.readInstallationIdentity,
      isApprovalExecutionOriginCurrent: source.isApprovalExecutionOriginCurrent,
      credentials: { token: 'alice-token', encryption: null } as never,
      targetActionApprovals: {
        targetActionApprovalsGet: async () => stored,
        targetActionApprovalsUpdate: async ({ request }) => {
          stored = TargetActionApprovalRequestV1Schema.parse(request);
          if (request.status === 'approved') entitled = false;
          return { ok: true };
        },
      },
    });
    await replay({ artifactId: 'bob-confidential', decision: 'approve', context: {
      surface: 'ui', authority: 'present_user', runtimeAccountId: 'alice',
      requesterApprovalDecision: { sessionId: 'bot-session', actor: { kind: 'accountUser', accountId: 'bob', relationship: 'sharedApprover' },
        isCurrent: async () => entitled },
    } });
    await expect(pending).resolves.toMatchObject({ ok: false, errorCode: 'approval_stale' });
    expect(effects).toBe(0);
    } finally {
      controller.abort();
      await pending;
    }
  });

  it.each([
    { dangerLevel: 'writesRemote', waive: false, readArm: false, sourceKind: 'pat', cancel: false },
    { dangerLevel: 'writesRemote', waive: true, readArm: false, sourceKind: 'pat', cancel: false },
    { dangerLevel: 'safe', waive: false, readArm: false, sourceKind: 'pat', cancel: false },
    { dangerLevel: 'writesRemote', waive: false, readArm: true, sourceKind: 'pat', cancel: false },
    { dangerLevel: 'writesRemote', waive: false, readArm: false, sourceKind: 'session', cancel: false },
    { dangerLevel: 'writesRemote', waive: false, readArm: false, sourceKind: 'session', cancel: false, workspaceWrites: 'allow' },
    { dangerLevel: 'writesRemote', waive: false, readArm: false, sourceKind: 'pat', cancel: true },
  ] as const)('binds a shared requester to the contributed effect (effect=$dangerLevel, waive=$waive, read=$readArm, source=$sourceKind, cancel=$cancel, writes=$workspaceWrites)', async scenario => {
    const { dangerLevel, waive, readArm, sourceKind, cancel } = scenario;
    const previousSettings = process.env.HAPPIER_ACTIONS_SETTINGS_V1;
    process.env.HAPPIER_ACTIONS_SETTINGS_V1 = JSON.stringify({ v: 1,
      ...(waive ? { approvalWaivedSurfaces: { 'acme.external/actions/inspect': ['agent'] } } : {}),
    });
    try {
      const source = createSharedBotContributedContext(sourceKind, 'workspaceWrites' in scenario ? scenario.workspaceWrites : undefined);
      let effects = 0;
      const runtime = createExternalActionRuntime('global', 'acme.external', () => { effects++; },
        undefined, undefined, undefined, undefined, dangerLevel, undefined, { surfaces: ['agent'],
          ...(readArm ? { confirmationWhen: { op: 'eq', path: 'mode', value: 'write' } } : {}) });
      const lease: PluginRuntimeRegistryLease = { registry: runtime, source: 'ephemeral',
        durableRevision: runtime.durableRevision ?? -1, release: async () => {} };
      let stored: TargetActionApprovalRequestV1 | null = null;
      const invoker = createDaemonExternalActionContributedInvoker({
        acquireRuntimeRegistryLease: async () => lease,
        requestCurrentIntent: createTargetActionCurrentIntentAdapter({
          create: async request => { stored = TargetActionApprovalRequestV1Schema.parse(request); return { artifactId: 'bob-write' }; },
          read: async () => stored,
        }),
      });
      const attribution = { requestRef: 'bob-request', requester: { serverId: 'server-external', accountId: 'bob' },
        persona: { serverId: 'server-external', sessionId: 'original-manager-session' }, origin: null } as const;
      const executor = createExternalActionExecutor(invoker);
      const result = await executor.execute('action.invoke', {
        action: { pluginId: 'acme.external', localId: 'inspect' }, input: { title: 'Approved release' },
      }, { ...source.context, actionRequestAttributionV1: attribution });
      if (waive || readArm || dangerLevel === 'safe') {
        expect(result.ok).toBe(true);
        expect(stored).toBeNull();
        expect(effects).toBe(1);
        return;
      }
      expect(result).toMatchObject({ ok: true, result: { kind: 'approval_request_created', artifactId: 'bob-write' } });
      expect(stored).toMatchObject({ requesterConfirmation: { requestRef: 'bob-request', requesterAccountId: 'bob',
        executionAccountId: 'alice', personaSessionRef: { serverId: 'server-external', sessionId: 'bot-session' } },
        executionOriginV1: { accountId: 'alice', actionRequestAttributionV1: attribution } });
      expect(effects).toBe(0);
      const replay = createDaemonExternalActionContributedApprovalReplay({
        readInstallationIdentity: source.readInstallationIdentity,
        credentials: { token: 'alice-token', encryption: null } as never,
        isApprovalExecutionOriginCurrent: source.isApprovalExecutionOriginCurrent,
        acquireRuntimeRegistryLease: async () => lease,
        targetActionApprovals: {
          targetActionApprovalsGet: async () => stored,
          targetActionApprovalsUpdate: async ({ request }) => { stored = TargetActionApprovalRequestV1Schema.parse(request); return { ok: true }; },
        },
      });
      let entitled = true;
      const bobContext: ActionExecutorContext = { surface: 'ui', authority: 'present_user', runtimeAccountId: 'alice',
        requesterApprovalDecision: { sessionId: 'bot-session', actor: { kind: 'accountUser', accountId: 'bob', relationship: 'sharedApprover' },
          isCurrent: async () => entitled } };
      const original = TargetActionApprovalRequestV1Schema.parse(stored);
      if (!original.executionOriginV1?.actionRequestAttributionV1 || !original.requesterConfirmation) throw new Error('Missing requester subject');
      stored = TargetActionApprovalRequestV1Schema.parse({ ...original,
        requesterConfirmation: { ...original.requesterConfirmation, requesterAccountId: 'carol' },
        executionOriginV1: { ...original.executionOriginV1, actionRequestAttributionV1: {
          ...original.executionOriginV1.actionRequestAttributionV1, requester: { serverId: 'server-external', accountId: 'carol' },
        } },
      });
      await expect(replay({ artifactId: 'bob-write', decision: 'approve', context: { ...bobContext,
        requesterApprovalDecision: { ...bobContext.requesterApprovalDecision!, actor: { kind: 'accountUser', accountId: 'carol', relationship: 'sharedApprover' } } } }))
        .resolves.toMatchObject({ ok: false, errorCode: 'approval_stale' });
      expect(effects).toBe(0);
      stored = original;
      await expect(replay({ artifactId: 'bob-write', decision: 'approve', context: { surface: 'agent', bypassApprovals: true } }))
        .resolves.toMatchObject({ ok: false, errorCode: 'present_user_required' });
      await expect(replay({ artifactId: 'bob-write', decision: 'reject', context: { ...bobContext,
        requesterApprovalDecision: { ...bobContext.requesterApprovalDecision!, actor: { kind: 'accountUser', accountId: 'carol', relationship: 'sharedApprover' } } } }))
        .resolves.toMatchObject({ ok: false, errorCode: 'present_user_required' });
      entitled = false;
      await expect(replay({ artifactId: 'bob-write', decision: 'approve', context: bobContext }))
        .resolves.toMatchObject({ ok: false, errorCode: 'approval_stale' });
      expect(stored).toMatchObject({ status: 'open' });
      expect(effects).toBe(0);
      entitled = true;
      if (cancel) {
        await expect(replay({ artifactId: 'bob-write', decision: 'cancel', context: { surface: 'agent', bypassApprovals: true } }))
          .resolves.toMatchObject({ ok: false, errorCode: 'present_user_required' });
        await expect(replay({ artifactId: 'bob-write', decision: 'cancel', context: bobContext }))
          .resolves.toMatchObject({ ok: true, result: { status: 'canceled' } });
        expect(stored).toMatchObject({ status: 'canceled' });
        expect(effects).toBe(0);
        return;
      }
      const replayResult = await replay({ artifactId: 'bob-write', decision: 'approve', context: bobContext });
      expect(replayResult, JSON.stringify(replayResult)).toMatchObject({ ok: true, result: { status: 'executed' } });
      expect(stored).toMatchObject({ status: 'executed', decision: { authority: 'present_user', decidingAccountId: 'bob' },
        executionOriginV1: { accountId: 'alice', actionRequestAttributionV1: attribution } });
      await expect(replay({ artifactId: 'bob-write', decision: 'approve', context: bobContext }))
        .resolves.toMatchObject({ ok: true, result: { status: 'executed' } });
      expect(effects).toBe(1);
    } finally {
      if (previousSettings === undefined) delete process.env.HAPPIER_ACTIONS_SETTINGS_V1;
      else process.env.HAPPIER_ACTIONS_SETTINGS_V1 = previousSettings;
    }
  });

  it.each([{ viaMeta: false, fails: false, losesExecutionClaim: false }, { viaMeta: true, fails: false, losesExecutionClaim: false },
    { viaMeta: false, fails: true, losesExecutionClaim: false }, { viaMeta: true, fails: true, losesExecutionClaim: false },
    { viaMeta: false, fails: false, losesExecutionClaim: true }])(
    'withholds confidential operands from every Workflow progress fact (meta=$viaMeta, fails=$fails, losesExecutionClaim=$losesExecutionClaim)', async ({ viaMeta, fails, losesExecutionClaim }) => {
    const secret = 'synthetic-workflow-confidential-operand';
    const workspace = { machineId: 'machine-local', directory: '/repo', checkoutRootPath: '/repo' };
    const inputSchema = { type: 'object', properties: { releaseTag: { type: 'string' }, public: { type: 'string' } }, required: ['releaseTag'] };
    const outputSchema = { type: 'object', required: ['surface'], properties: { surface: { const: 'agent' } } };
    const authorization = { admittedPermissionCeiling: 'default' as const, principal: { kind: 'session' as const, sessionId: 'origin' } };
    const qualifiedId = 'acme.external/actions/inspect';
    const actionInput = { releaseTag: secret, public: 'public-endpoint' };
    const accepted = await materializeWorkflowAcceptedSnapshotV1({
      definition: { version: 1, inputs: [], defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } },
        blocks: [{ kind: 'action', id: 'inspect', actionId: viaMeta ? 'action.invoke' : qualifiedId,
          input: viaMeta ? { action: { kind: 'literal', value: { pluginId: 'acme.external', localId: 'inspect' } },
            input: { kind: 'literal', value: actionInput } } : { releaseTag: { kind: 'literal', value: secret }, public: { kind: 'literal', value: 'public-endpoint' } } }] },
      context: { source: { kind: 'inline' }, inputs: {}, machineId: workspace.machineId, executionTarget: { kind: 'session' },
        workspaceTarget: { project: workspace }, origin: { kind: 'direct' }, authorization }, admission: { kind: 'user' },
      effects: { resolveTargetAvailability: async () => true, readActionContract: async id => {
        if (id === qualifiedId) return { inputSchema, outputSchema };
        const spec = getActionSpec('action.invoke');
        return { inputSchema: normalizePluginJsonSchema(zodSchemaToJsonSchemaObject(spec.inputSchema, { target: 'draft-7' })),
          outputSchema: normalizePluginJsonSchema(zodSchemaToJsonSchemaObject(spec.outputSchema!, { target: 'draft-7' })) };
      } },
    });
    if (!accepted.ok) throw new Error(accepted.error.code);
    let stored: TargetActionApprovalRequestV1 | undefined;
    let effects = 0;
    const runtime = createExternalActionRuntime('global', 'acme.external', () => { effects++; if (fails) throw new Error('synthetic failure'); }, undefined,
      () => ({ serverId: 'server-external', machineId: 'machine-local' }), undefined, undefined, 'writesRemote', undefined,
      { surfaces: ['agent', 'plugin'], inputSchema, resultSchema: outputSchema,
        inputHints: { fields: [{ path: 'releaseTag', title: 'Release credential', widget: 'secret' }] },
        onInput: input => { expect(input).toEqual(actionInput); } });
    const lease = { registry: runtime, source: 'ephemeral' as const, durableRevision: runtime.durableRevision ?? -1, release: async () => {} };
    const invoker = createCommittedContributedActionInvoker({ acquireRuntimeRegistryLease: async () => lease,
      requestCurrentIntent: createTargetActionCurrentIntentAdapter({
        create: async request => { stored = TargetActionApprovalRequestV1Schema.parse(JSON.parse(JSON.stringify(request))); return { artifactId: 'secret-workflow' }; },
        read: async () => {
          if (!stored) return null;
          // Simulate consent once; subsequent reads must observe the real claim and receipt.
          if (stored.status === 'open') stored = TargetActionApprovalRequestV1Schema.parse({ ...stored,
            status: 'approved', decision: { kind: 'approve', decidedAtMs: stored.updatedAtMs } });
          // A mis-bound reader must not authorize settlement from stale consent.
          return losesExecutionClaim && stored.status === 'executing' ? { ...stored, status: 'approved' } : stored;
        },
        update: async ({ request }) => { stored = TargetActionApprovalRequestV1Schema.parse(request); return { ok: true }; },
      }),
    });
    const listDefinitions = createDaemonExternalActionContributedDefinitionLister({ tryAcquireRuntimeRegistryLease: () => lease });
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), invokeContributedAction: invoker,
      listContributedActionDefinitions: listDefinitions, readContributedActionSchemas: createCommittedContributedActionSchemaReader(listDefinitions) });
    const store = createInMemoryWorkflowCoordinatorStore();
    const facts: unknown[] = [];
    const coordinator = createWorkflowCoordinator({ store: { ...store, commitFact: async fact => {
      facts.push(JSON.parse(JSON.stringify(fact))); return await store.commitFact(fact);
    } }, executeStep: async () => { throw new Error('No step'); }, resolveWorkspace: async () => ({ ok: true, workspace }),
      isAcceptedAuthorizationCurrent: async () => true, action: { executor, buildContext: async params => ({ ...buildWorkflowActionContext(params),
        serverId: 'server-external', runtimeAccountId: 'account-1', executionRunTargetMachineId: 'machine-local' }), observeRun: async () => { throw new Error('No Run'); } } });
    try {
      const runId = '88888888-8888-4888-8888-888888888888';
      const outcome = await coordinator.run({ ...accepted.snapshot, runId });
      expect(outcome, JSON.stringify(outcome)).toMatchObject({ state: fails || losesExecutionClaim ? 'failed' : 'succeeded' });
      if (losesExecutionClaim) expect(outcome).toMatchObject({ reason: 'approval_execution_outcome_unknown' });
      expect(effects).toBe(1);
      expect(stored).toMatchObject({ status: losesExecutionClaim ? 'executing' : fails ? 'failed' : 'executed' });
      if (!losesExecutionClaim) expect(stored?.execution).toMatchObject({ ok: !fails });
      expect(stored?.approvalInputCustody).toBe('live_only');
      expect(JSON.stringify(stored)).not.toContain(secret);
      expect(JSON.stringify(facts)).not.toContain(secret);
      const row = store.list().find(row => row.blockId === 'inspect')!;
      const saved = (await store.readInvocationBindingRow!(row.recordId))!;
      const progress = WorkflowProgressEnvelopeV1Schema.parse(saved.progress);
      expect(JSON.stringify(progress)).not.toContain(secret);
      expect(progress.execution?.kind === 'action' ? progress.execution.input : undefined).toEqual(viaMeta
        ? { action: { pluginId: 'acme.external', localId: 'inspect' }, input: stored!.input } : stored!.input);
      const run = WorkflowRunSummaryV1Schema.parse({ id: runId, sourceArtifactId: null,
        attentionRequired: false, failureUnseen: false, invocationAttentionRequired: false, attentionSeenFailureAt: null, finishedAt: null,
        ownerAccountId: 'account-1', visibleTeamId: null, origin: { kind: 'direct' }, state: outcome.state, revision: 1,
        machineId: workspace.machineId, workflowCustodyState: 'settled', originDeliveryAckRevision: null,
        availability: { pause: false, resumeBoundary: false, restoreWorkspace: false, cancel: false, inspectExecution: true, disabledReasons: [] },
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' });
      const keyCensus = WorkflowRunRecipientCensusResponseV1Schema.parse({ runId, visibleTeamId: null,
        ownerAccountId: 'account-1', encryptionMode: 'plain', access: 'owner', dataEncryptionKey: null,
        callerDataEncryptionKey: null, recipients: [], ownerAccountCurrentness: { mode: 'plain', version: 1, contentKeyFingerprint: null } });
      const contentEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({ mode: 'plain',
        binding: { v: 1, purpose: 'invocation_progress', accountId: 'account-1', runId, recordId: saved.index.id,
          sequence: saved.index.sequence, parentRecordId: saved.index.parentRecordId, memberOrdinal: saved.index.memberOrdinal, attempt: saved.index.attempt }, progress }));
      const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
        binding: { v: 1, purpose: 'accepted_snapshot', accountId: 'account-1', runId }, acceptedSnapshot: accepted.snapshot }));
      const reads = createWorkflowAccountRunActionOwner({ resolveAccountId: async () => 'account-1',
        definitions: { get: async () => { throw new Error('No definition read'); } },
        resolveEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
        storage: { execute: async operation => {
          if (operation.operation === 'get') return { run, keyCensus, acceptedEnvelope, checkpointEnvelope: null, resultEnvelope: null };
          if (operation.operation === 'invocations.get') return { invocation: { index: saved.index, contentEnvelope, parentRevision: 1 } };
          if (operation.operation === 'invocations.list') return { invocations: [saved.index], parentRevision: 1, keyCensus,
            progressEnvelopesByInvocationId: { [saved.index.id]: contentEnvelope } };
          throw new Error(`Unexpected storage read ${String(operation.operation)}`);
        } },
      });
      const detail = await reads.execute({ actionId: 'workflow.run.invocations.get', input: { runId, invocationId: saved.index.id }, context: {} });
      const list = await reads.execute({ actionId: 'workflow.run.invocations.list', input: { runId, includeContent: true }, context: {} });
      expect(JSON.stringify([detail, list])).not.toContain(secret);
      expect(detail).toMatchObject({ invocation: { progress: { execution: { input: progress.execution?.kind === 'action' ? progress.execution.input : {} } } } });
      expect(list).toMatchObject({ invocationDetails: [{ progress: { execution: { input: progress.execution?.kind === 'action' ? progress.execution.input : {} } } }] });
    } finally { await runtime.dispose(); }
  });

  it.each([
    { decision: 'approve', viaMeta: false }, { decision: 'reject', viaMeta: false },
    { decision: 'approve', viaMeta: true }, { decision: 'reject', viaMeta: true },
  ] as const)('retains and resumes a Workflow deferred approval ($decision, meta=$viaMeta)', async ({ decision, viaMeta }) => {
    const qualifiedId = 'acme.external/actions/inspect';
    const artifactId = `workflow-approval-${decision}`;
    const workspace = { machineId: 'machine-local', directory: '/repo', checkoutRootPath: '/repo' };
    const authorization = { admittedPermissionCeiling: 'default' as const,
      principal: { kind: 'session' as const, sessionId: 'origin' } };
    const definition: WorkflowDefinitionV1 = { version: 1 as const, inputs: [], defaults: {
      agentTarget: { kind: 'agent' as const, identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
    }, blocks: [{ kind: 'action' as const, id: 'inspect', actionId: viaMeta ? 'action.invoke' : qualifiedId,
      input: viaMeta ? {
        action: { kind: 'literal', value: { pluginId: 'acme.external', localId: 'inspect' } },
        input: { kind: 'literal', value: {} },
      } : {} }] };
    const outputSchema = { type: 'object', required: ['surface'], properties: { surface: { const: 'agent' } } };
    const accepted = await materializeWorkflowAcceptedSnapshotV1({ definition,
      context: { source: { kind: 'inline' }, inputs: {}, machineId: workspace.machineId, executionTarget: { kind: 'session' },
        workspaceTarget: { project: workspace }, origin: { kind: 'direct' }, authorization }, admission: { kind: 'user' },
      effects: { resolveTargetAvailability: async () => true,
        readActionContract: async id => {
          if (id === qualifiedId) return { inputSchema: { type: 'object' }, outputSchema };
          const spec = getActionSpec('action.invoke');
          return { inputSchema: normalizePluginJsonSchema(zodSchemaToJsonSchemaObject(spec.inputSchema, { target: 'draft-7' })),
            outputSchema: normalizePluginJsonSchema(zodSchemaToJsonSchemaObject(spec.outputSchema!, { target: 'draft-7' })) };
        } },
    });
    if (!accepted.ok) throw new Error(accepted.error.code);
    let effects = 0;
    let approvalsCreated = 0;
    let stored: TargetActionApprovalRequestV1 | undefined;
    const runtime = createExternalActionRuntime('global', 'acme.external', () => { effects++; }, undefined,
      () => ({ serverId: 'server-external', machineId: 'machine-local' }), undefined, undefined, 'writesRemote', undefined,
      { surfaces: ['agent', 'plugin'], resultSchema: outputSchema });
    expect(runtime.contributes.actions[0]?.definition.outputSchema).toEqual(outputSchema);
    const acquire = async () => ({ registry: runtime, source: 'ephemeral' as const,
      durableRevision: runtime.durableRevision ?? -1, release: async () => {} });
    const invoker = createCommittedContributedActionInvoker({ acquireRuntimeRegistryLease: acquire,
      requestCurrentIntent: createTargetActionCurrentIntentAdapter({
        create: async request => { approvalsCreated++; stored = TargetActionApprovalRequestV1Schema.parse(request); return { artifactId }; },
        read: async () => stored ?? null,
      }),
    });
    const replay = createDaemonExternalActionContributedApprovalReplay({
      credentials: { token: 'daemon-token', encryption: { type: 'legacy', secret: EXTERNAL_ACTION_ENCRYPTION_KEY } }, acquireRuntimeRegistryLease: acquire,
      isApprovalExecutionOriginCurrent: async () => true,
      targetActionApprovals: {
        targetActionApprovalsGet: async () => stored ?? null,
        targetActionApprovalsUpdate: async ({ request }) => {
          stored = TargetActionApprovalRequestV1Schema.parse(JSON.parse(JSON.stringify(request)));
          return { ok: true };
        },
      },
    });
    const listDefinitions = createDaemonExternalActionContributedDefinitionLister({ tryAcquireRuntimeRegistryLease: () => ({
      registry: runtime, source: 'ephemeral', durableRevision: runtime.durableRevision ?? -1, release: async () => {},
    }) });
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), invokeContributedAction: invoker,
      listContributedActionDefinitions: listDefinitions, readContributedActionSchemas: createCommittedContributedActionSchemaReader(listDefinitions),
      approvalsGet: async () => stored ?? null, targetActionApprovalReplay: replay });
    const store = createInMemoryWorkflowCoordinatorStore();
    const createCoordinator = () => createWorkflowCoordinator({ store,
      executeStep: async () => { throw new Error('No step expected'); },
      resolveWorkspace: async () => ({ ok: true, workspace }), isAcceptedAuthorizationCurrent: async () => true,
      action: { executor, buildContext: async params => ({ ...buildWorkflowActionContext(params),
        serverId: 'server-external', runtimeAccountId: 'account-1', executionRunTargetMachineId: 'machine-local' }),
        observeRun: async () => { throw new Error('No Run expected'); } },
    });
    const input = { ...accepted.snapshot, runId: '99999999-9999-4999-8999-999999999999' };
    const row = () => store.list().find(item => item.blockId === 'inspect');
    try {
      const held = await createCoordinator().run(input);
      expect(held, JSON.stringify(held)).toMatchObject({ state: 'paused', reason: 'approval_required' });
      expect(stored?.status).toBe('open');
      expect(effects).toBe(0);
      expect(row()).toMatchObject({ lifecycle: 'waiting_for_approval', execution: {
        output: { kind: 'approval_request_created', artifactId, actionId: 'action.invoke' },
      } });
      const recovery = createWorkflowInvocationRecoveryObserver({
        credentials: { token: 'daemon-token', encryption: { type: 'legacy', secret: EXTERNAL_ACTION_ENCRYPTION_KEY } },
        machineId: workspace.machineId, actionExecutor: executor,
      });
      expect(await recovery({ progress: WorkflowProgressEnvelopeV1Schema.parse({ kind: 'happier.workflow-progress.v1',
        invocationPath: { blockId: 'inspect', scope: [] }, blockKind: 'action', attempt: '0',
        logicalInvocationRecordId: row()!.logicalInvocationRecordId ?? row()!.recordId,
        execution: JSON.parse(JSON.stringify(row()!.execution)) }), terminalParent: false, cancellationRequested: false }))
        .toMatchObject({ kind: 'unresolved', code: 'approval_required' });
      // Reclaim while still open must preserve the exact request, not dispatch again.
      expect(await createCoordinator().run(input)).toMatchObject({ state: 'paused', reason: 'approval_required' });
      expect(approvalsCreated).toBe(1);
      const decided = await executor.execute('approval.request.decide', { artifactId, decision }, {
        surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' },
      });
      expect(decided, JSON.stringify(decided)).toMatchObject({ ok: true });
      const afterRestart = await recovery({ run: { id: input.runId }, progress: WorkflowProgressEnvelopeV1Schema.parse({
        kind: 'happier.workflow-progress.v1', invocationPath: { blockId: 'inspect', scope: [] },
        blockKind: 'action', attempt: '0', logicalInvocationRecordId: row()!.logicalInvocationRecordId ?? row()!.recordId,
        execution: JSON.parse(JSON.stringify(row()!.execution)),
      }), terminalParent: false, cancellationRequested: false });
      expect(afterRestart).toMatchObject(decision === 'approve'
        ? { kind: 'completed', result: { surface: 'agent' } } : { kind: 'failed', code: 'approval_rejected' });
      const savedProgress = WorkflowProgressEnvelopeV1Schema.parse((await store.readInvocationBindingRow!(row()!.recordId))!.progress);
      expect(await observeWorkflowInvocationRecoveryEvidence({
        runId: input.runId, credentials: { token: 'daemon-token', encryption: null }, machineId: workspace.machineId, progress: savedProgress,
        getRun: async () => { throw new Error('Approval has no native Run'); },
        getApproval: async artifactId => {
          const read = await executor.execute('approval.request.get', { artifactId }, { surface: 'agent' });
          return read.ok ? read.result : null;
        },
      })).toMatchObject({ activity: 'not_active', canReattach: true, canContinueConversation: false });
      expect(await recovery({ run: { id: input.runId }, progress: savedProgress, terminalParent: false, cancellationRequested: false, observationOnly: true }))
        .toMatchObject(afterRestart);
      // The public boundary control must admit the retained Run after restart.
      // The storage boundary enforces the server's paused-only resume contract;
      // no test invokes a coordinator until the public control accepts it.
      let state: string = held.state;
      const run = () => WorkflowRunSummaryV1Schema.parse({ id: input.runId, sourceArtifactId: null,
        attentionRequired: false, failureUnseen: false, invocationAttentionRequired: false, attentionSeenFailureAt: null, finishedAt: null,
        ownerAccountId: 'account-1', visibleTeamId: null, origin: { kind: 'direct' }, state, revision: 1,
        machineId: workspace.machineId, workflowCustodyState: 'pending', originDeliveryAckRevision: null,
        availability: { pause: false, resumeBoundary: state === 'paused', restoreWorkspace: false, cancel: true, inspectExecution: true, disabledReasons: [] },
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' });
      const controls = createWorkflowAccountRunActionOwner({ resolveAccountId: async () => 'account-1',
        definitions: { get: async () => { throw new Error('No definition read'); } },
        resolveEncryption: async () => { throw new Error('Boundary resume is key-free'); },
        storage: { execute: async operation => {
          if (operation.operation !== 'resume' || state !== 'paused') throw new Error('ineligible_state');
          state = 'queued'; // The server queues the retained frontier for the next daemon claim.
          return { intent: 'resumed', run: run() };
        } },
      });
      expect(await controls.execute({ actionId: 'workflow.run.resume',
        input: { mode: 'boundary', runId: input.runId, expectedRevision: 1 }, context: {} })).toMatchObject({ intent: 'resumed' });
      expect(await createCoordinator().run(input)).toMatchObject(decision === 'approve'
        ? { state: 'succeeded' } : { state: 'failed', reason: 'approval_rejected' });
      expect(effects).toBe(decision === 'approve' ? 1 : 0);
      if (decision === 'approve') {
        expect(row()?.result).toMatchObject({ surface: 'agent' });
        expect(await createCoordinator().run(input)).toMatchObject({ state: 'succeeded' });
        expect(effects).toBe(1);
      }
      expect(row()?.execution).toMatchObject({ output: { kind: 'approval_request_created', artifactId } });
      expect(approvalsCreated).toBe(1);
    } finally { await runtime.dispose(); }
  });

  it.each([
    { surface: 'agent', decision: 'approve' }, { surface: 'mcp', decision: 'approve' },
    { surface: 'cli', decision: 'approve' }, { surface: 'api', decision: 'approve' },
    { surface: 'api', decision: 'reject' }, { surface: 'cli', decision: 'retire' },
  ] as const)('approves confidential $surface input only through live custody ($decision)', async ({ surface, decision }) => {
    const artifactId = `live-secret-${surface}-${decision}`;
    const secret = 'synthetic-live-release-tag';
    let stored: TargetActionApprovalRequestV1 | undefined;
    let received: JsonValue | undefined;
    let invalidate: (() => void) | undefined;
    const runtime = createExternalActionRuntime('global', 'acme.external', undefined, undefined,
      () => ({ serverId: 'server-external', machineId: 'machine-local' }), undefined, undefined,
      'writesRemote', undefined, {
        surfaces: ['agent', 'mcp', 'cli'],
        inputSchema: { type: 'object', properties: { releaseTag: { type: 'string' }, public: { type: 'string' } },
          required: ['releaseTag', 'public'], additionalProperties: false },
        inputHints: { fields: [{ path: 'releaseTag', title: 'Release credential', widget: 'secret' }] },
        onInput: input => { received = input; },
      });
    const lease = { registry: runtime, source: 'ephemeral' as const,
      durableRevision: runtime.durableRevision ?? -1, release: async () => {} };
    const acquire = vi.fn(async () => lease);
    const invoker = createDaemonExternalActionContributedInvoker({
      acquireRuntimeRegistryLease: acquire,
      requestCurrentIntent: createTargetActionCurrentIntentAdapter({
        create: async request => {
          stored = TargetActionApprovalRequestV1Schema.parse(JSON.parse(JSON.stringify(request)));
          return { artifactId };
        },
        read: async () => stored ?? null,
        update: async ({ request }) => {
          stored = TargetActionApprovalRequestV1Schema.parse(JSON.parse(JSON.stringify(request)));
          return { ok: true };
        },
        subscribeChanges: (_artifactId, onChange) => {
          invalidate = onChange;
          return { dispose: () => { invalidate = undefined; } };
        },
      }),
    });
    const replay = createDaemonExternalActionContributedApprovalReplay({
      credentials: { token: 'daemon-token', encryption: null } as never,
      acquireRuntimeRegistryLease: acquire,
      targetActionApprovals: {
        targetActionApprovalsGet: async () => stored ?? null,
        targetActionApprovalsUpdate: async ({ request }) => {
          stored = TargetActionApprovalRequestV1Schema.parse(JSON.parse(JSON.stringify(request)));
          // Account change delivery can precede the decision write's HTTP
          // response. Exercise that real transport ordering at the boundary.
          invalidate?.();
          await Promise.resolve();
          return { ok: true };
        },
      },
    });
    const controller = new AbortController();
    const pending = invoker({ action: { pluginId: 'acme.external', localId: 'inspect' },
      input: { releaseTag: secret, public: ' endpoint ' },
      ...(surface === 'api' ? { approvalExecutionOrigin: createApiActionApprovalOrigin() } : {}),
      context: { surface, authority: 'account_automation', actionCaller: { kind: 'host' },
        ...(surface === 'cli' ? { defaultSessionId: 'session-live' } : {}) }, signal: controller.signal });
    try {
      await vi.waitFor(() => expect(getSharedBlockingApprovalCoordinator().getLiveWaiterCount(artifactId)).toBe(1));
      expect(stored).toMatchObject({ approvalInputCustody: 'live_only', input: { public: ' endpoint ' },
        replayPlacement: { serverId: 'server-external', machineId: 'machine-local' } });
      expect(JSON.stringify(stored)).not.toContain(secret);
      const admission = resolveApprovalRequestApproveAdmission(stored!);
      expect(admission).toMatchObject({ status: 'available', presentation: { rows: expect.arrayContaining([
        { kind: 'value', path: 'input.releaseTag', title: 'Release credential', value: '', valueFormat: 'confidential' },
        { kind: 'value', path: 'input.public', title: 'Public', value: '" endpoint "' },
      ]) } });
      expect(JSON.stringify(admission)).not.toContain(secret);
      const reads = createActionExecutor({
        approvalsGet: async () => stored ?? null,
        approvalsList: async () => ({ items: [{ artifactId, status: stored!.status,
          actionId: stored!.qualifiedActionId, summary: stored!.summary, updatedAtMs: stored!.updatedAtMs }] }),
      } as unknown as ActionExecutorDeps);
      const cliContext = { surface: 'cli' as const, authority: 'account_automation' as const, actionCaller: { kind: 'host' as const } };
      const disclosed = await reads.execute('approval.request.get', { artifactId }, cliContext);
      expect(disclosed).toMatchObject({ ok: true, result: { artifactId, request: {
        status: 'open', approvalInputCustody: 'live_only', input: { public: ' endpoint ' },
      } } });
      expect(JSON.stringify(disclosed)).not.toContain(secret);
      expect(await reads.execute('approval.request.list', { status: 'open' }, cliContext))
        .toMatchObject({ ok: true, result: { items: [{ artifactId, status: 'open' }] } });
      if (decision === 'retire') {
        runtime.targetActionInvocations?.dispose();
        await vi.waitFor(() => expect(getSharedBlockingApprovalCoordinator().getLiveWaiterCount(artifactId)).toBe(0));
        await expect(pending).resolves.toMatchObject({ ok: false });
        await expect(replay({ artifactId, decision: 'approve' })).resolves.toMatchObject({ ok: false, errorCode: 'approval_stale' });
        expect(received).toBeUndefined();
        return;
      }
      if (decision === 'reject') {
        await expect(replay({ artifactId, decision: 'reject' })).resolves.toMatchObject({ ok: true, result: { status: 'rejected' } });
        await expect(pending).resolves.toMatchObject({ ok: false, errorCode: 'plugin_action_current_intent_rejected' });
        expect(received).toBeUndefined();
        return;
      }
      await expect(replay({ artifactId, decision: 'approve', ...(surface === 'cli' ? {
        callerGrant: { ...API_TOKEN_FULL_GRANT_V1, approve: true, targets: { sessions: ['session-live'], machines: [] } },
      } : {}) })).resolves.toMatchObject({ ok: true, result: { status: 'approved' } });
      await expect(pending).resolves.toMatchObject({ ok: true });
      expect(received).toEqual({ releaseTag: secret, public: ' endpoint ' });
      expect(stored).toMatchObject({ status: 'executed', execution: { ok: true } });
      expect(JSON.stringify(stored)).not.toContain(secret);
      expect(acquire).toHaveBeenCalledTimes(1);
      // Terminal history returns its receipt without reconstructing confidential input.
      await expect(replay({ artifactId, decision: 'approve' })).resolves.toMatchObject({
        ok: true, result: { status: 'executed', execution: { ok: true } },
      });
      expect(acquire).toHaveBeenCalledTimes(1);
    } finally {
      controller.abort();
      await pending;
      await runtime.dispose();
    }
  });

  it.each(['cli', 'mcp', 'agent'] as const)('preserves %s approval custody and user waivers through public action.invoke', async surface => {
    const previousSettings = process.env.HAPPIER_ACTIONS_SETTINGS_V1;
    const actionId = 'acme.external/actions/inspect';
    process.env.HAPPIER_ACTIONS_SETTINGS_V1 = JSON.stringify({ v: 1, actions: {} });
    let invocationCount = 0;
    let stored: TargetActionApprovalRequestV1 | undefined;
    const runtime = createExternalActionRuntime('global', 'acme.external', () => { invocationCount += 1; },
      undefined, undefined, undefined, undefined, 'writesRemote', undefined,
      { surfaces: ['cli', 'mcp', 'agent'] });
    // Artifact persistence is the boundary. The manifest, invocation routing,
    // policy, approval producer and strict consumer remain real.
    const create = vi.fn(async (request: TargetActionApprovalRequestV1) => {
      stored = TargetActionApprovalRequestV1Schema.parse(request);
      return { artifactId: `approval-${surface}` };
    });
    const lease = { registry: runtime, source: 'ephemeral' as const,
      durableRevision: runtime.durableRevision ?? -1, release: async () => {} };
    const invoker = createDaemonExternalActionContributedInvoker({
      acquireRuntimeRegistryLease: async () => lease,
      requestCurrentIntent: createTargetActionCurrentIntentAdapter({
        create,
        read: async () => stored ? TargetActionApprovalRequestV1Schema.parse({
          ...stored, status: 'approved', decision: { kind: 'approve', decidedAtMs: stored.updatedAtMs },
        }) : null,
      }),
    });
    const replay = createDaemonExternalActionContributedApprovalReplay({
      credentials: { token: 'fixture-token', encryption: null },
      acquireRuntimeRegistryLease: async () => lease,
      // Home origin/currentness and Artifact persistence are external boundaries.
      isApprovalExecutionOriginCurrent: async () => true,
      targetActionApprovals: {
        targetActionApprovalsGet: async () => stored ?? null,
        targetActionApprovalsUpdate: async ({ request }) => { stored = TargetActionApprovalRequestV1Schema.parse(request); return { ok: true }; },
      },
    });
    const executor = createActionExecutor({
      invokeContributedAction: invoker,
      targetActionApprovalReplay: replay,
    } as unknown as ActionExecutorDeps);
    const context = { surface, authority: 'account_automation' as const, actionCaller: { kind: 'host' as const },
      serverId: 'server-external', actionRequestId: `request-${surface}`, runtimeAccountId: 'account-1',
      executionRunTargetMachineId: 'machine-local' };
    const app = await createDaemonControlApp({
      getChildren: () => [], machineId: 'machine-local',
      stopSession: async () => ({ status: 'not_found' }),
      spawnSession: async () => ({ type: 'success', sessionId: 'unused' }),
      requestShutdown: () => {}, onHappySessionWebhook: () => {}, controlToken: 'fixture-control',
      externalActionApi: { currentServerId: 'server-external', currentAccountId: 'account-1',
        verifyPat: async () => { throw new Error('Unexpected PAT'); }, executor,
        resolveTarget: async () => ({ kind: 'machine', machineId: 'machine-local' }),
      },
    });
    const actionInput = {
      action: { pluginId: 'acme.external', localId: 'inspect' }, input: {},
    };
    const execute = async () => surface === 'agent' ? executor.execute('action.invoke', actionInput, context)
      : (await app.inject({ method: 'POST', url: '/actions/root/execute',
        headers: { 'x-happier-daemon-token': 'fixture-control' },
        payload: { actionId: 'action.invoke', input: actionInput, surface, actionRequestId: `request-${surface}` },
      })).json();
    try {
      const deferred = await execute();
      expect(deferred, JSON.stringify(deferred)).toMatchObject({ ok: true, result: {
        kind: 'approval_request_created', artifactId: `approval-${surface}`, actionId: 'action.invoke',
      } });
      expect(stored).toMatchObject({ requestedSurface: surface, createdBy: { surface }, qualifiedActionId: actionId });
      expect(stored).toMatchObject({ replayPlacement: { serverId: 'server-external', machineId: 'machine-local' },
        executionOriginV1: { surface, actionId: 'action.invoke' } });
      expect(invocationCount).toBe(0);
      expect(await replay({ artifactId: `approval-${surface}`, decision: 'approve' }))
        .toMatchObject({ ok: true, result: { status: 'executed', execution: { ok: true } } });
      expect(invocationCount).toBe(1);

      process.env.HAPPIER_ACTIONS_SETTINGS_V1 = JSON.stringify(setActionApprovalOverride({
        settings: ActionsSettingsV1Schema.parse({ v: 1, actions: {} }), actionId, surface, approvalRequired: false,
      }));
      await expect(execute()).resolves.toMatchObject({ ok: true, result: { surface, caller: null } });
      expect(create).toHaveBeenCalledOnce();
      expect(invocationCount).toBe(2);
    } finally {
      await app.close();
      await runtime.dispose();
      if (previousSettings === undefined) delete process.env.HAPPIER_ACTIONS_SETTINGS_V1;
      else process.env.HAPPIER_ACTIONS_SETTINGS_V1 = previousSettings;
    }
  });

  it.each(['api', 'rpc'] as const)('preserves %s caller provenance accepted by the Triage caller owner through real dispatch', async surface => {
    let hostCallerAccepted: boolean | undefined;
    const runtime = createExternalActionRuntime('global', 'happier.triage', (context) => {
      expect(context.surface).toBe('api');
      expect(context.caller).toBeUndefined();
      hostCallerAccepted = isTriageHostActionCaller(context);
    });
    const invoker = createDaemonExternalActionContributedInvoker({
      acquireRuntimeRegistryLease: async () => ({ registry: runtime, source: 'ephemeral',
        durableRevision: runtime.durableRevision ?? -1, release: async () => {} }),
    });
    try {
      expect(await invoker({ action: { pluginId: 'happier.triage', localId: 'inspect' }, input: {},
        context: { surface, actionCaller: { kind: 'host' } } }))
        .toMatchObject({ ok: true, result: { surface: 'api', caller: null } });
      expect(hostCallerAccepted).toBe(true);
    } finally { await runtime.dispose(); }
  });

  it.each(['host', 'host_waived', 'session', 'retired'] as const)('preserves the accepted workflow caller and canonical approval gate (%s)', async origin => {
    const previousSettings = process.env.HAPPIER_ACTIONS_SETTINGS_V1;
    if (origin === 'host_waived') process.env.HAPPIER_ACTIONS_SETTINGS_V1 = JSON.stringify(setActionApprovalOverride({
      settings: ActionsSettingsV1Schema.parse({ v: 1, actions: {} }),
      actionId: 'acme.external/actions/inspect', surface: 'agent', approvalRequired: false,
    }));
    const seeds: PluginActionsServiceSeed[] = [];
    const runtime = createExternalActionRuntime('global', 'acme.external', undefined, undefined, undefined,
      seed => { seeds.push(seed); }, undefined, 'writesRemote', undefined, { surfaces: ['agent', 'plugin'] });
    const approve = vi.fn(async (request: TargetActionCurrentIntentRequest) => ({
      status: 'approved' as const, fingerprint: request.fingerprint,
    }));
    const invoker = createCommittedContributedActionInvoker({
      acquireRuntimeRegistryLease: async () => ({ registry: runtime, source: 'ephemeral',
        durableRevision: runtime.durableRevision ?? -1, release: async () => {} }),
      requestCurrentIntent: approve,
    });
    const authorization = { admittedPermissionCeiling: 'default' as const,
      principal: origin === 'session' ? { kind: 'session' as const, sessionId: 'origin' }
        : origin === 'retired' ? { kind: 'plugin' as const, pluginId: 'acme.retired',
          sourceCustody: { kind: 'development' as const, registeredRootId: 'retired-root' } }
          : { kind: 'host' as const } };
    const context = buildWorkflowActionContext({ runId: 'workflow-run', authorization });
    try {
      const result = await invoker({ action: { pluginId: 'acme.external', localId: 'inspect' }, input: {}, context });
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
      expect(seeds).toHaveLength(1);
      expect(seeds[0]?.initiatingActionCaller).toEqual(context.actionCaller);
      if (origin === 'host_waived') {
        expect(approve).not.toHaveBeenCalled();
      } else {
        expect(approve).toHaveBeenCalledWith(expect.objectContaining({
          invocationSurface: 'agent',
          executionOriginV1: expect.objectContaining({ surface: 'agent', caller: context.actionCaller }),
        }));
      }
    } finally {
      await runtime.dispose();
      if (previousSettings === undefined) delete process.env.HAPPIER_ACTIONS_SETTINGS_V1;
      else process.env.HAPPIER_ACTIONS_SETTINGS_V1 = previousSettings;
    }
  });

  it('keeps projected Tool and discovered Action identities distinct when local IDs overlap the Action namespace', async () => {
    let invocationCount = 0;
    const runtime = createExternalActionRuntime('global', 'acme.external', () => { invocationCount += 1; },
      undefined, undefined, undefined, undefined, 'safe', undefined, { overlappingTool: true });
    const pluginToolCatalog = projectOccurrenceBoundExecutablePluginToolCatalog(runtime);
    expect(pluginToolCatalog).toMatchObject([{ actionId: 'acme.external/actions/actions/inspect' }]);
    const lease = { registry: runtime, source: 'ephemeral', durableRevision: -1, release: async () => {} } satisfies PluginRuntimeRegistryLease;
    const listDefinitions = createDaemonExternalActionContributedDefinitionLister({ tryAcquireRuntimeRegistryLease: () => lease });
    const base = createActionExecutor({ listContributedActionDefinitions: listDefinitions,
      readContributedActionSchemas: createCommittedContributedActionSchemaReader(listDefinitions) } as unknown as ActionExecutorDeps);
    const executor = createPluginActionExecutor({ base, requestPluginActionExecution: async (request) => request.actionId === 'action.spec.get'
      ? { matched: true, result: await base.execute('action.spec.get', request.input, { surface: request.surface }) }
      : executeContributedAction({ runtimeRegistry: runtime, actionId: request.actionId, input: request.input, context: { surface: request.surface },
        ...(request.expectedContributorOccurrenceId ? { expectedContributorOccurrenceId: request.expectedContributorOccurrenceId } : {}),
        actionsSettings: ActionsSettingsV1Schema.parse({ v: 1, actions: {} }) }) });
    const bridge = createActionToolExecutorBridge({ surface: 'cli', executor, pluginToolCatalog });
    const execute = (actionId: string) => dispatchBuiltInHappierTool({ toolName: 'action_execute', args: { actionId, input: {} },
      sessionId: 'session-1', surface: 'cli', pluginToolCatalog,
      deps: { changeTitle: async () => { throw new Error('Unexpected title change'); }, executeActionByToolName: bridge.executeActionByToolName } });
    await expect(execute('acme.external/actions/inspect')).resolves.toMatchObject({ ok: true, result: { localId: 'inspect' } });
    await expect(execute(pluginToolCatalog[0]!.actionId)).resolves.toMatchObject({ ok: true, result: { localId: 'actions/inspect' } });
    await expect(bridge.executeActionByToolName('acme_inspect', {}, 'session-1')).resolves.toMatchObject({ ok: true, result: { localId: 'actions/inspect' } });
    expect(invocationCount).toBe(3);
    // A previously delivered catalog snapshot cannot borrow a replacement
    // contributor's admission, through either the named or generic Tool.
    const retiredBridge = createActionToolExecutorBridge({ surface: 'cli', executor,
      pluginToolCatalog: pluginToolCatalog.map((tool) => ({ ...tool,
        expectedContributorOccurrenceId: createPluginRuntimeOccurrenceId('acme.external') })) });
    await expect(retiredBridge.executeActionByToolName('acme_inspect', {}, 'session-1')).resolves.toMatchObject({ ok: false });
    await expect(retiredBridge.executeActionByToolName('action_execute', { actionId: pluginToolCatalog[0]!.actionId, input: {} }, 'session-1')).resolves.toMatchObject({ ok: false });
    expect(invocationCount).toBe(3);
  });

  it('keeps generic qualified Actions subject to real catalog and surface admission', async () => {
    for (const unavailable of [false, true]) {
      let invoked = false;
      const runtime = createExternalActionRuntime('global', 'acme.external', () => { invoked = true; },
        undefined, undefined, undefined, undefined, 'safe', undefined,
        { surfaces: ['cli'], ...(unavailable ? { unavailable: true } : {}) });
      const lease = { registry: runtime, source: 'ephemeral', durableRevision: -1, release: async () => {} } satisfies PluginRuntimeRegistryLease;
      const listDefinitions = createDaemonExternalActionContributedDefinitionLister({ tryAcquireRuntimeRegistryLease: () => lease });
      const base = createActionExecutor({ listContributedActionDefinitions: listDefinitions,
        readContributedActionSchemas: createCommittedContributedActionSchemaReader(listDefinitions) } as unknown as ActionExecutorDeps);
      const executor = createPluginActionExecutor({ base, requestPluginActionExecution: async (request) => request.actionId === 'action.spec.get'
        ? { matched: true, result: await base.execute('action.spec.get', request.input, { surface: request.surface }) }
        : executeContributedAction({ runtimeRegistry: runtime, actionId: request.actionId, input: request.input,
          context: { surface: request.surface }, actionsSettings: ActionsSettingsV1Schema.parse({ v: 1, actions: {} }) }) });
      const surface = unavailable ? 'cli' : 'mcp';
      const bridge = createActionToolExecutorBridge({ surface, executor, pluginToolCatalog: [] });
      await expect(dispatchBuiltInHappierTool({ toolName: 'action_execute', args: { actionId: 'acme.external/actions/inspect', input: {} },
        sessionId: 'session-1', surface, pluginToolCatalog: [],
        deps: { changeTitle: async () => { throw new Error('Unexpected title change'); }, executeActionByToolName: bridge.executeActionByToolName } })).resolves.toMatchObject({ ok: false });
      expect(invoked).toBe(false);
    }
  });

  it('executes a discovered qualified Action without a Tool on each host surface under canonical preferences', async () => {
    for (const localId of ['inspect', 'actions/inspect']) {
      for (const surface of ['cli', 'mcp', 'agent'] as const) {
        let invocationCount = 0;
        const runtime = createExternalActionRuntime('global', 'acme.external', () => { invocationCount += 1; },
          undefined, undefined, undefined, undefined, 'writesRemote', undefined,
          { localId, surfaces: ['cli', 'mcp', 'agent'] });
        expect(projectOccurrenceBoundExecutablePluginToolCatalog(runtime)).toHaveLength(0);
        const lease = { registry: runtime, source: 'ephemeral', durableRevision: -1, release: async () => {} } satisfies PluginRuntimeRegistryLease;
        const listDefinitions = createDaemonExternalActionContributedDefinitionLister({ tryAcquireRuntimeRegistryLease: () => lease });
        const actionId = formatQualifiedPluginActionId({ pluginId: 'acme.external', localId });
        let settings = ActionsSettingsV1Schema.parse({ v: 1, actions: {} });
        const base = createActionExecutor({ listContributedActionDefinitions: listDefinitions,
          readContributedActionSchemas: createCommittedContributedActionSchemaReader(listDefinitions) } as unknown as ActionExecutorDeps);
        const executor = createPluginActionExecutor({
          base,
          // Daemon IPC is the boundary. Both catalog admission and handler
          // dispatch below retain their real normalized registry and policy.
          requestPluginActionExecution: async (request) => request.actionId === 'action.spec.get'
            ? { matched: true, result: await base.execute('action.spec.get', request.input, { surface: request.surface, actionsSettings: settings }) }
            : executeContributedAction({ runtimeRegistry: runtime, actionId: request.actionId, input: request.input,
              actionsSettings: settings, context: { surface: request.surface },
              requestCurrentIntent: async () => ({ status: 'rejected', code: 'plugin_action_current_intent_rejected' }) }),
        });
        const bridge = createActionToolExecutorBridge({ surface, executor, pluginToolCatalog: [], getActionsSettings: () => settings });
        const execute = () => dispatchBuiltInHappierTool({ toolName: 'action_execute', args: { actionId, input: {} }, sessionId: 'session-1',
          surface, pluginToolCatalog: [], getActionsSettings: () => settings,
          deps: { changeTitle: async () => { throw new Error('Unexpected title change'); }, executeActionByToolName: bridge.executeActionByToolName } });
        expect(await base.execute('action.spec.get', { id: actionId }, { surface })).toMatchObject({ ok: true, result: { actionSpec: { id: actionId } } });
        await expect(execute()).resolves.toMatchObject({ ok: false, errorCode: 'plugin_action_current_intent_rejected' });
        expect(invocationCount).toBe(0);
        settings = setActionApprovalOverride({ settings, actionId, surface, approvalRequired: false });
        await expect(execute()).resolves.toMatchObject({ ok: true, result: { surface, caller: null } });
        expect(invocationCount).toBe(1);
        settings = ActionsSettingsV1Schema.parse({ v: 1, actions: { [actionId]: { ...settings.actions[actionId], enabled: false } } });
        await expect(execute()).resolves.toMatchObject({ ok: false, errorCode: 'action_disabled' });
        expect(invocationCount).toBe(1);
        settings = ActionsSettingsV1Schema.parse({ v: 1, actions: { [actionId]: { ...settings.actions[actionId], enabled: true } } });
        settings = setActionApprovalOverride({ settings, actionId, surface, approvalRequired: null });
        await expect(execute()).resolves.toMatchObject({ ok: false, errorCode: 'plugin_action_current_intent_rejected' });
        expect(invocationCount).toBe(1);
      }
    }
  });

  it.each([
    { surface: 'cli', dangerLevel: 'safe' }, { surface: 'cli', dangerLevel: 'writesRemote' },
    { surface: 'mcp', dangerLevel: 'writesRemote' }, { surface: 'agent', dangerLevel: 'writesRemote' },
  ] as const)('executes a discovered $dangerLevel qualified Action through the real credentialed $surface caller and daemon adapter', async ({ surface, dangerLevel }) => {
    const runtime = createExternalActionRuntime('global', 'acme.external', undefined, undefined, undefined, undefined, undefined, dangerLevel,
      undefined, { surfaces: ['cli', 'mcp', 'agent'] });
    let stored: TargetActionApprovalRequestV1 | undefined;
    const lease = { registry: runtime, source: 'ephemeral', durableRevision: -1, release: async () => {} } satisfies PluginRuntimeRegistryLease;
    const listDefinitions = createDaemonExternalActionContributedDefinitionLister({ tryAcquireRuntimeRegistryLease: () => lease });
    const settings = ActionsSettingsV1Schema.parse({ v: 1, actions: {} });
    const daemonExecutor = createActionExecutor({ listContributedActionDefinitions: listDefinitions,
      readContributedActionSchemas: createCommittedContributedActionSchemaReader(listDefinitions) } as unknown as ActionExecutorDeps);
    // The actual daemon HTTP/IPC boundary alone is replaced; credentialed CLI
    // context preparation, discovery, dynamic adapter and policy remain real.
    vi.spyOn(daemonControlClient, 'requestDaemonPluginActionExecution').mockImplementation(async (request) => request.actionId === 'action.spec.get'
      ? { matched: true, result: await daemonExecutor.execute('action.spec.get', request.input, { surface: request.surface }) }
      : executeContributedAction({ runtimeRegistry: runtime, actionId: request.actionId, input: request.input,
        context: { surface: request.surface }, actionsSettings: settings,
        requestCurrentIntent: createTargetActionCurrentIntentAdapter({
          create: async request => { stored = TargetActionApprovalRequestV1Schema.parse(request); return { artifactId: 'qualified-approval' }; },
          read: async () => stored ?? null,
        }),
      }));
    const executor = createCliActionExecutorFromCredentials({
      credentials: { token: 'fixture-cli-token', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) } },
      serverId: 'fixture-home', serverApiUrl: 'https://fixture-home.example.test', serverIdentityId: 'server-external', machineId: 'machine-local',
      resolveServerFeaturesSnapshot: async () => undefined,
      actionsSettingsProvider: createActionSettingsProvider({ accountSettings: accountSettingsParse({ actionsSettingsV1: settings }) }),
    });
    const bridge = createActionToolExecutorBridge({ surface, executor, pluginToolCatalog: [] });
    await expect(dispatchBuiltInHappierTool({ toolName: 'action_execute', args: { actionId: 'acme.external/actions/inspect', input: {} },
      sessionId: 'session-1', surface, pluginToolCatalog: [],
      deps: { changeTitle: async () => { throw new Error('Unexpected title change'); }, executeActionByToolName: bridge.executeActionByToolName } })).resolves.toMatchObject({
      ok: true, result: dangerLevel === 'safe' ? { surface, caller: null }
        : { kind: 'approval_request_created', artifactId: 'qualified-approval', actionId: 'action.invoke' },
    });
    if (dangerLevel !== 'safe') expect(stored).toMatchObject({ requestedSurface: surface,
      replayPlacement: { serverId: 'server-external', machineId: 'machine-local' },
      executionOriginV1: { actionId: 'action.invoke', surface } });
  });

  it('allows a source read but rejects writes under the same current read-only invocation lease', async () => {
    for (const dangerLevel of ['safe', 'writesRemote'] as const) {
      let invoked = false;
      const runtime = createExternalActionRuntime('global', 'acme.external', () => { invoked = true; },
        undefined, undefined, undefined, undefined, dangerLevel);
      const lease = { registry: runtime, source: 'ephemeral', durableRevision: -1, release: async () => {} } satisfies PluginRuntimeRegistryLease;
      const executor = createExternalActionExecutor(createDaemonExternalActionContributedInvoker({
        acquireRuntimeRegistryLease: async () => lease,
      }));
      const result = await executor.execute('action.invoke', { action: { pluginId: 'acme.external', localId: 'inspect' }, input: {} }, {
        surface: 'api', requiredContributedActionDangerLevel: 'safe',
      });
      expect(result).toMatchObject(dangerLevel === 'safe'
        ? { ok: true, result: { surface: 'api' } }
        : { ok: false, errorCode: 'plugin_action_read_only_required' });
      expect(invoked).toBe(dangerLevel === 'safe');
    }
  });

  it('keeps read-only source invocation subject to the exact contributed Action API grant', async () => {
    let invoked = false;
    const runtime = createExternalActionRuntime('global', 'acme.external', () => { invoked = true; });
    const lease = { registry: runtime, source: 'ephemeral', durableRevision: -1, release: async () => {} } satisfies PluginRuntimeRegistryLease;
    const executor = createExternalActionExecutor(createDaemonExternalActionContributedInvoker({
      acquireRuntimeRegistryLease: async () => lease,
    }));
    await expect(executor.execute('action.invoke', { action: { pluginId: 'acme.external', localId: 'inspect' }, input: {} }, {
      surface: 'api', requiredContributedActionDangerLevel: 'safe',
      externalActionCredential: { accountId: 'account-1', principalId: 'principal-1',
        credentialId: '11111111-1111-4111-8111-111111111111',
        grant: { ...API_TOKEN_FULL_GRANT_V1, actions: { families: [], ids: ['action.invoke'] } },
      },
    })).resolves.toMatchObject({ ok: false, errorCode: 'credential_scope_denied' });
    expect(invoked).toBe(false);
    await expect(executor.execute('action.invoke', { action: { pluginId: 'acme.external', localId: 'inspect' }, input: {} }, {
      surface: 'api', requiredContributedActionDangerLevel: 'safe',
      externalActionCredential: { accountId: 'account-1', principalId: 'principal-1',
        credentialId: '11111111-1111-4111-8111-111111111111',
        grant: { ...API_TOKEN_FULL_GRANT_V1, actions: { families: [], ids: ['acme.external/actions/inspect'] } },
      },
    })).resolves.toMatchObject({ ok: true, result: { surface: 'api' } });
    expect(invoked).toBe(true);
  });
  it('rejects a write source before activating its unbound contributor', async () => {
    let activated = false;
    const runtime = createExternalActionRuntime('global', 'acme.external', undefined,
      undefined, undefined, undefined, undefined, 'writesRemote', () => { activated = true; });
    const lease = { registry: runtime, source: 'ephemeral', durableRevision: -1, release: async () => {} } satisfies PluginRuntimeRegistryLease;
    const executor = createExternalActionExecutor(createDaemonExternalActionContributedInvoker({
      acquireRuntimeRegistryLease: async () => lease,
    }));
    await expect(executor.execute('action.invoke', { action: { pluginId: 'acme.external', localId: 'inspect' }, input: {} }, {
      surface: 'api', requiredContributedActionDangerLevel: 'safe',
    })).resolves.toMatchObject({ ok: false, errorCode: 'plugin_action_read_only_required' });
    expect(activated).toBe(false);
  });
  it('invokes the committed contributor through authenticated exact-machine Action RPC without borrowing plugin identity', async () => {
    const executor = createExternalActionIngressExecutor();
    const handlers = new Map<string, (input: unknown) => Promise<unknown>>();
    const controller = new AbortController();
    registerActionSpecRpcHandlers({
      rpcHandlerManager: { registerHandler: (method, handler) => {
        handlers.set(method, (input) => handler(input, { signal: controller.signal, callerAuthority: 'present_user' }));
      } },
      actionExecutor: executor,
      actionIds: ['action.invoke'],
      targetMachineId: 'machine-local',
    });
    // The released exact-machine RPC adapter remains an authenticated ingress.
    // Account Actions now use the private original-root HTTP transport instead.
    const action = async (request: Readonly<{ input: unknown; context: Readonly<{
      defaultSessionId: string; externalActionTarget: Readonly<{ kind: 'machine'; machineId: string }>;
    }> }>) => {
      const method = getActionSpec('action.invoke').bindings?.rpcMethod;
      const handler = method ? handlers.get(method) : undefined;
      if (!handler) return { ok: false, errorCode: 'method_not_found' };
      return handler(createTargetedActionRpcRequestV1(request.input, request.context.externalActionTarget,
        { defaultSessionId: request.context.defaultSessionId }));
    };
    const request = { actionId: 'action.invoke' as const, input: { action: { pluginId: 'acme.external', localId: 'inspect' }, input: {} },
      context: { serverId: 'server-external', runtimeAccountId: 'account-1', defaultSessionId: 'session-origin',
        externalActionTarget: { kind: 'machine' as const, machineId: 'machine-local' } } };
    await expect(action(request)).resolves.toEqual({ surface: 'api', caller: null, sessionId: 'session-origin' });
    await expect(action({ ...request, context: { ...request.context,
      externalActionTarget: { kind: 'machine', machineId: 'wrong-machine' } } })).resolves.toMatchObject({ ok: false });
    controller.abort();
    await expect(action(request)).resolves.toMatchObject({ ok: false });
  });
  it('feeds current committed plugin definitions to API Action discovery without retaining the runtime lease', async () => {
    const runtime = createExternalActionRuntime('global');
    let runtimeAvailable = true;
    let retireAfterCatalogRead = false;
    const release = vi.fn(async () => {
      if (retireAfterCatalogRead) runtimeAvailable = false;
    });
    const lease: PluginRuntimeRegistryLease = {
      registry: runtime,
      source: 'active',
      durableRevision: runtime.durableRevision ?? -1,
      release,
    };
    const listContributedActionDefinitions = createDaemonExternalActionContributedDefinitionLister({
      tryAcquireRuntimeRegistryLease: () => runtimeAvailable ? lease : null,
    });
    const definitions = listContributedActionDefinitions();
    expect(definitions).toEqual([
      expect.objectContaining({ id: 'acme.external/actions/inspect' }),
    ]);
    const [definition] = definitions;
    expect(definition).toBeDefined();
    expect(definition).not.toHaveProperty('scopes');
    expect(definition).not.toHaveProperty('contributionSurfaces');
    expect(definition).not.toHaveProperty('placementBindings');
    expect(definition).not.toHaveProperty('availability');
    expect(definition).not.toHaveProperty('hostAccess');
    expect(definition).not.toHaveProperty('priority');
    expect(definition).not.toHaveProperty('dangerLevel');
    expect(StrictJsonValueSchema.safeParse(definition).success).toBe(true);
    const executor = createCliActionExecutor({
      token: 'discovery-token',
      sessionId: 'session-discovery',
      mode: 'plain',
      ctx: null,
      pluginActionExecutionOwner: 'current_process',
      invokeContributedAction: createDaemonExternalActionContributedInvoker({
        acquireRuntimeRegistryLease: async () => lease,
      }),
      listContributedActionDefinitions,
    });
    const context = {
      surface: 'api' as const,
      externalActionCredential: {
        accountId: 'account-1',
        principalId: 'principal-1',
        credentialId: '11111111-1111-4111-8111-111111111111',
        grant: ApiTokenGrantV1Schema.parse({
          v: 1,
          actions: { families: [], ids: ['acme.external/actions/inspect'] },
          targets: null,
          approve: false,
          origins: [],
          models: null,
          permissionModes: null,
          create: null,
        }),
      },
    };
    const declaredAction = runtime.contributes.actions[0];
    if (!declaredAction) throw new Error('Expected current contributed Action declaration');

    // Exercise the real CLI composition before search: a host schema-export
    // failure must not obscure the missing on-demand contributed schema owner.
    const get = await executor.execute(
      'action.spec.get',
      { id: 'acme.external/actions/inspect' },
      context,
    );
    expect(get).toMatchObject({
      ok: true,
      result: {
        actionSpec: expect.objectContaining({
          id: 'acme.external/actions/inspect',
          inputSchema: declaredAction.definition.inputSchema ?? {},
          ...(declaredAction.definition.outputSchema === undefined
            ? {}
            : { outputSchema: declaredAction.definition.outputSchema }),
        }),
      },
    });
    if (!get.ok) throw new Error('Expected contributed Action lookup to succeed');
    expect(StrictJsonValueSchema.safeParse(get.result).success).toBe(true);

    // Retiring the runtime after the summary read must prevent the subsequent
    // schema read from disclosing a declaration retained from that old lease.
    retireAfterCatalogRead = true;
    await expect(executor.execute(
      'action.spec.get',
      { id: 'acme.external/actions/inspect' },
      context,
    )).resolves.toMatchObject({ ok: false, errorCode: 'unavailable' });
    retireAfterCatalogRead = false;
    runtimeAvailable = true;

    const search = await executor.execute(
      'action.spec.search',
      { query: 'inspect', limit: 5 },
      context,
    );
    expect(search, JSON.stringify(search)).toMatchObject({
      ok: true,
      result: {
        actionSpecs: expect.arrayContaining([
          expect.objectContaining({ id: 'acme.external/actions/inspect' }),
        ]),
      },
    });
    if (!search.ok) throw new Error('Expected contributed Action search to succeed');
    expect(StrictJsonValueSchema.safeParse(search.result).success).toBe(true);

    expect(release).toHaveBeenCalled();
  });

  it('does not advertise a contributed Action rejected by the runtime catalog policy', () => {
    const runtime = createExternalActionRuntime('global');
    const targetActionInvocations = runtime.targetActionInvocations;
    if (!targetActionInvocations) throw new Error('Expected complete Action invocation fixture');
    const evaluateCatalogPolicy = vi.fn(() => ({
      outcome: 'denied',
      code: 'plugin_action_grant_revoked',
      requiresCurrentIntent: false,
    } as const));
    const deniedRuntime: ResolvedExecutablePluginRuntimeRegistry = {
      ...runtime,
      targetActionInvocations: {
        ...targetActionInvocations,
        evaluateCatalogPolicy,
      },
    };
    const listContributedActionDefinitions = createDaemonExternalActionContributedDefinitionLister({
      tryAcquireRuntimeRegistryLease: () => ({
        registry: deniedRuntime,
        source: 'active',
        durableRevision: deniedRuntime.durableRevision ?? -1,
        release: async () => {},
      }),
    });

    expect(listContributedActionDefinitions()).toEqual([]);
    expect(evaluateCatalogPolicy).toHaveBeenCalledWith('acme.external', 'inspect');
  });

  it('does not advertise contributed Actions when the applied runtime is unavailable', () => {
    const listContributedActionDefinitions = createDaemonExternalActionContributedDefinitionLister({
      tryAcquireRuntimeRegistryLease: () => null,
    });

    expect(listContributedActionDefinitions()).toEqual([]);
  });

  it('keeps equal local ids from separate plugins distinct in external Action discovery', async () => {
    const alphaRuntime = createExternalActionRuntime('global', 'acme.alpha');
    const betaRuntime = createExternalActionRuntime('global', 'acme.beta');
    const alphaTargetActionInvocations = alphaRuntime.targetActionInvocations;
    const betaTargetActionInvocations = betaRuntime.targetActionInvocations;
    if (!alphaTargetActionInvocations || !betaTargetActionInvocations) {
      throw new Error('Expected complete Action invocation fixtures');
    }
    const runtime: ResolvedExecutablePluginRuntimeRegistry = {
      ...alphaRuntime,
      contributes: {
        ...alphaRuntime.contributes,
        actions: [...alphaRuntime.contributes.actions, ...betaRuntime.contributes.actions],
      },
      targetActionInvocations: {
        ...alphaTargetActionInvocations,
        evaluateCatalogPolicy: (pluginId, localId) => (
          pluginId === 'acme.beta'
            ? betaTargetActionInvocations.evaluateCatalogPolicy(pluginId, localId)
            : alphaTargetActionInvocations.evaluateCatalogPolicy(pluginId, localId)
        ),
      },
    };
    const lease: PluginRuntimeRegistryLease = {
      registry: runtime,
      source: 'active',
      durableRevision: runtime.durableRevision ?? -1,
      release: async () => {},
    };
    const listContributedActionDefinitions = createDaemonExternalActionContributedDefinitionLister({
      tryAcquireRuntimeRegistryLease: () => lease,
    });
    expect(listContributedActionDefinitions()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'acme.alpha/actions/inspect' }),
      expect.objectContaining({ id: 'acme.beta/actions/inspect' }),
    ]));
    const executor = createExternalActionExecutor(
      createDaemonExternalActionContributedInvoker({
        acquireRuntimeRegistryLease: async () => lease,
      }),
      listContributedActionDefinitions,
    );

    await expect(executor.execute(
      'action.spec.search',
      { query: 'inspect', limit: 5 },
      { surface: 'api' },
    )).resolves.toMatchObject({
      ok: true,
      result: {
        actionSpecs: expect.arrayContaining([
          expect.objectContaining({ id: 'acme.alpha/actions/inspect' }),
          expect.objectContaining({ id: 'acme.beta/actions/inspect' }),
        ]),
      },
    });
    await expect(executor.execute(
      'action.spec.get',
      { id: 'acme.alpha/actions/inspect' },
      { surface: 'api' },
    )).resolves.toMatchObject({
      ok: true,
      result: {
        actionSpec: expect.objectContaining({ id: 'acme.alpha/actions/inspect' }),
      },
    });
    await expect(executor.execute(
      'action.spec.get',
      { id: 'acme.beta/actions/inspect' },
      { surface: 'api' },
    )).resolves.toMatchObject({
      ok: true,
      result: {
        actionSpec: expect.objectContaining({ id: 'acme.beta/actions/inspect' }),
      },
    });
  });

  it('uses the verified envelope Session target to invoke a real session-scoped external Action', async () => {
    const executor = createExternalActionIngressExecutor('session');

    await expect(executeExternalAction({
      actionId: 'action.invoke',
      envelope: {
        v: 1,
        target: { kind: 'session', sessionId: 'session-verified' },
        input: {
          action: { pluginId: 'acme.external', localId: 'inspect' },
          // This remains plugin payload, not a Session selector.
          input: { sessionId: 'session-forged-in-plugin-input' },
        },
      },
      principal: {
        accountId: 'account-1',
        principalId: 'principal-1',
        credentialId: 'credential-1',
        authority: 'account_automation',
      },
      currentMachineId: 'machine-local',
      resolveTarget: createCanonicalSessionTargetResolver(),
      executor,
    })).resolves.toMatchObject({
      kind: 'response',
      response: {
        v: 1,
        actionId: 'action.invoke',
        execution: {
          ok: true,
          result: {
            surface: 'api',
            caller: null,
            sessionId: 'session-verified',
          },
        },
      },
    });

    expect(externalActionTargetResolverMocks.fetchSessionById).toHaveBeenCalledWith({
      token: 'daemon-token',
      sessionId: 'session-verified',
    });
  });

  it('refuses unavailable Account currentness before dispatching an external Action Session target', async () => {
    const executor = createExternalActionIngressExecutor('session');
    const execute = vi.spyOn(executor, 'execute');
    const resolveTarget = createCanonicalSessionTargetResolver();
    vi.mocked(axios.get).mockRejectedValue(new Error('Account currentness transport unavailable'));

    await expect(executeExternalAction({
      actionId: 'action.invoke',
      envelope: {
        v: 1,
        target: { kind: 'session', sessionId: 'session-verified' },
        input: { action: { pluginId: 'acme.external', localId: 'inspect' }, input: {} },
      },
      principal: {
        accountId: 'account-1', principalId: 'principal-1', credentialId: 'credential-1',
        authority: 'account_automation',
      },
      currentMachineId: 'machine-local',
      resolveTarget,
      executor,
    })).resolves.toMatchObject({
      kind: 'response',
      response: { execution: { ok: false, errorCode: 'target_unavailable' } },
    });
    // Session lookup may overlap the fresh Account witness, but an unavailable
    // witness must never publish a target to the Action executor.
    expect(execute).not.toHaveBeenCalled();
  });

  it('does not let nested plugin input select a Session without a verified envelope target', async () => {
    const executor = createExternalActionIngressExecutor('session');
    const resolveTarget = createDaemonExternalActionTargetResolver({
      credentials: { token: 'daemon-token', encryption: null },
    });
    externalActionTargetResolverMocks.fetchSessionById.mockClear();

    await expect(executeExternalAction({
      actionId: 'action.invoke',
      envelope: {
        v: 1,
        input: {
          action: { pluginId: 'acme.external', localId: 'inspect' },
          input: { sessionId: 'session-forged-in-plugin-input' },
        },
      },
      principal: {
        accountId: 'account-1',
        principalId: 'principal-1',
        credentialId: 'credential-1',
        authority: 'account_automation',
      },
      currentMachineId: 'machine-local',
      resolveTarget,
      executor,
    })).resolves.toMatchObject({
      kind: 'response',
      response: {
        actionId: 'action.invoke',
        execution: {
          ok: false,
          errorCode: 'plugin_action_session_required',
        },
      },
    });
    expect(externalActionTargetResolverMocks.fetchSessionById).not.toHaveBeenCalled();
  });

  it('keeps a non-session external Action on the same verified Session target path', async () => {
    const executor = createExternalActionIngressExecutor('global');

    await expect(executeExternalAction({
      actionId: 'action.invoke',
      envelope: {
        v: 1,
        target: { kind: 'session', sessionId: 'session-verified' },
        input: {
          action: { pluginId: 'acme.external', localId: 'inspect' },
          input: {},
        },
      },
      principal: {
        accountId: 'account-1',
        principalId: 'principal-1',
        credentialId: 'credential-1',
        authority: 'account_automation',
      },
      currentMachineId: 'machine-local',
      resolveTarget: createCanonicalSessionTargetResolver(),
      executor,
    })).resolves.toMatchObject({
      kind: 'response',
      response: {
        execution: {
          ok: true,
          result: { sessionId: 'session-verified' },
        },
      },
    });
  });

  it('keeps an unscoped external Action executable on the current machine', async () => {
    const executor = createExternalActionIngressExecutor('global');
    const resolveTarget = createDaemonExternalActionTargetResolver({
      credentials: { token: 'daemon-token', encryption: null },
    });
    externalActionTargetResolverMocks.fetchSessionById.mockClear();

    await expect(executeExternalAction({
      actionId: 'action.invoke',
      envelope: {
        v: 1,
        input: {
          action: { pluginId: 'acme.external', localId: 'inspect' },
          input: {},
        },
      },
      principal: {
        accountId: 'account-1',
        principalId: 'principal-1',
        credentialId: 'credential-1',
        authority: 'account_automation',
      },
      currentMachineId: 'machine-local',
      resolveTarget,
      executor,
    })).resolves.toMatchObject({
      kind: 'response',
      response: {
        execution: {
          ok: true,
          result: { sessionId: null },
        },
      },
    });
    expect(externalActionTargetResolverMocks.fetchSessionById).not.toHaveBeenCalled();
  });

  it('rejects a Session target the canonical locality owner cannot prove local', async () => {
    const executor = createExternalActionIngressExecutor('session');

    await expect(executeExternalAction({
      actionId: 'action.invoke',
      envelope: {
        v: 1,
        target: { kind: 'session', sessionId: 'session-verified' },
        input: {
          action: { pluginId: 'acme.external', localId: 'inspect' },
          input: {},
        },
      },
      principal: {
        accountId: 'account-1',
        principalId: 'principal-1',
        credentialId: 'credential-1',
        authority: 'account_automation',
      },
      currentMachineId: 'machine-local',
      resolveTarget: createCanonicalSessionTargetResolver({
        machineId: 'machine-elsewhere',
        host: 'host-elsewhere',
        homeDir: '/home/elsewhere',
      }),
      executor,
    })).resolves.toMatchObject({
      kind: 'response',
      response: {
        execution: {
          ok: false,
          errorCode: 'target_not_local',
        },
      },
    });
  });

  it('runs a parsed external manifest Action through settings-required approve and reject intent decisions', async () => {
    const previousSettings = process.env.HAPPIER_ACTIONS_SETTINGS_V1;
    process.env.HAPPIER_ACTIONS_SETTINGS_V1 = JSON.stringify({
      v: 1,
      actions: {
        'acme.external/actions/inspect': {
          approvalRequiredSurfaces: ['api'],
        },
      },
    });
    try {
      const runtime = createExternalActionRuntime();
      const lease: PluginRuntimeRegistryLease = {
        registry: runtime,
        source: 'ephemeral',
        durableRevision: runtime.durableRevision ?? -1,
        release: async () => {},
      };
      const acquireRuntimeRegistryLease = async (): Promise<PluginRuntimeRegistryLease> => lease;
      const approve = vi.fn(async (request: TargetActionCurrentIntentRequest) => ({
        status: 'approved' as const,
        fingerprint: request.fingerprint,
      }));
      const approvedInvokerOptions = {
        acquireRuntimeRegistryLease,
        requestCurrentIntent: approve,
      };
      const approved = createDaemonExternalActionContributedInvoker(approvedInvokerOptions);
      const context = {
        surface: 'api' as const,
        authority: 'account_automation' as const,
        actionCaller: { kind: 'host' as const },
        defaultSessionId: 'session-1',
      };

      await expect(approved({
        action: { pluginId: 'acme.external', localId: 'inspect' },
        input: {},
        context,
        signal: new AbortController().signal,
      })).resolves.toEqual({
        ok: true,
        result: { surface: 'api', caller: null, sessionId: 'session-1' },
      });
      expect(approve).toHaveBeenCalledWith(expect.objectContaining({
        surface: 'api',
        invocationSurface: 'api',
      }));

      const reject = vi.fn(async () => ({
        status: 'rejected' as const,
        code: 'plugin_action_current_intent_rejected',
      }));
      const rejectedInvokerOptions = {
        acquireRuntimeRegistryLease,
        requestCurrentIntent: reject,
      };
      const rejected = createDaemonExternalActionContributedInvoker(rejectedInvokerOptions);

      await expect(rejected({
        action: { pluginId: 'acme.external', localId: 'inspect' },
        input: {},
        context,
        signal: new AbortController().signal,
      })).resolves.toMatchObject({
        ok: false,
        errorCode: 'plugin_action_current_intent_rejected',
        actionHandlerInvocation: 'notStarted',
      });
      expect(reject).toHaveBeenCalledOnce();
    } finally {
      if (previousSettings === undefined) delete process.env.HAPPIER_ACTIONS_SETTINGS_V1;
      else process.env.HAPPIER_ACTIONS_SETTINGS_V1 = previousSettings;
    }
  });

  it('returns a deferred generic approval artifact for an API Ask-first contributed Action', async () => {
    const previousSettings = process.env.HAPPIER_ACTIONS_SETTINGS_V1;
    process.env.HAPPIER_ACTIONS_SETTINGS_V1 = JSON.stringify({
      v: 1,
      actions: {
        'acme.external/actions/inspect': {
          approvalRequiredSurfaces: ['api'],
        },
      },
    });
    try {
      let executionOriginReads = 0;
      const runtime = createExternalActionRuntime(
        'global',
        'acme.external',
        undefined,
        (pluginId) => {
          executionOriginReads += 1;
          return {
            serverIdentityId: 'server-external',
            materializationRef: {
              pluginId,
              machineId: 'machine-local',
              materializationId: 'fixture-materialization',
            },
          };
        },
      );
      const lease: PluginRuntimeRegistryLease = {
        registry: runtime,
        source: 'ephemeral',
        durableRevision: runtime.durableRevision ?? -1,
        release: async () => {},
      };
      const requestCurrentIntent = vi.fn(async () => ({
        status: 'deferred',
        artifactId: 'approval-api-required-1',
      } as never));
      const executor = createExternalActionExecutor(
        createDaemonExternalActionContributedInvoker({
          acquireRuntimeRegistryLease: async () => lease,
          requestCurrentIntent,
        }),
        createDaemonExternalActionContributedDefinitionLister({
          tryAcquireRuntimeRegistryLease: () => lease,
        }),
      );

      await expect(executeExternalAction({
        actionId: 'action.invoke',
        envelope: {
          v: 1,
          input: {
            action: { pluginId: 'acme.external', localId: 'inspect' },
            input: {},
          },
        },
        principal: {
          accountId: 'account-1',
          principalId: 'principal-1',
          credentialId: 'credential-1',
          authority: 'account_automation',
        },
        currentMachineId: 'machine-local',
        resolveTarget: createDaemonExternalActionTargetResolver({
          credentials: { token: 'daemon-token', encryption: null },
        }),
        executor,
      })).resolves.toMatchObject({
        kind: 'response',
        response: {
          actionId: 'action.invoke',
          execution: {
            ok: true,
            result: {
              kind: 'approval_request_created',
              artifactId: 'approval-api-required-1',
              actionId: 'action.invoke',
            },
          },
        },
      });
      expect(requestCurrentIntent).toHaveBeenCalledWith(expect.objectContaining({
        replayPlacement: {
          serverId: 'server-external',
          machineId: 'machine-local',
        },
      }));
      expect(executionOriginReads).toBe(0);
    } finally {
      if (previousSettings === undefined) delete process.env.HAPPIER_ACTIONS_SETTINGS_V1;
      else process.env.HAPPIER_ACTIONS_SETTINGS_V1 = previousSettings;
    }
  });

  it('does not post-veto a direct API contributed Action when its execution origin changes', async () => {
    let originRead = 0;
    let actionInvocations = 0;
    const runtime = createExternalActionRuntime(
      'global',
      'acme.external',
      () => { actionInvocations += 1; },
      (pluginId) => {
        originRead += 1;
        return {
          serverIdentityId: 'server-external',
          materializationRef: {
            pluginId,
            machineId: 'machine-local',
            materializationId: originRead === 1 ? 'before-effect' : 'after-effect',
          },
        };
      },
    );
    const lease: PluginRuntimeRegistryLease = {
      registry: runtime,
      source: 'ephemeral',
      durableRevision: runtime.durableRevision ?? -1,
      release: async () => {},
    };
    const invoke = createDaemonExternalActionContributedInvoker({
      acquireRuntimeRegistryLease: async () => lease,
    });

    await expect(invoke({
      action: { pluginId: 'acme.external', localId: 'inspect' },
      input: {},
      context: {
        surface: 'api',
        authority: 'account_automation',
        actionCaller: { kind: 'host' },
      },
      signal: new AbortController().signal,
    })).resolves.toEqual({
      ok: true,
      result: { surface: 'api', caller: null, sessionId: null },
    });
    expect(actionInvocations).toBe(1);
    expect(originRead).toBe(0);
  });

  it('executes a materializationless bundled API Action without requiring an execution origin', async () => {
    let actionInvocations = 0;
    const runtime = createExternalActionRuntime(
      'global',
      'happier.channels',
      () => { actionInvocations += 1; },
      () => null,
    );
    const lease: PluginRuntimeRegistryLease = {
      registry: runtime,
      source: 'ephemeral',
      durableRevision: runtime.durableRevision ?? -1,
      release: async () => {},
    };
    const invoke = createDaemonExternalActionContributedInvoker({
      acquireRuntimeRegistryLease: async () => lease,
    });

    await expect(invoke({
      action: { pluginId: 'happier.channels', localId: 'inspect' },
      input: {},
      context: {
        surface: 'api',
        authority: 'account_automation',
        actionCaller: { kind: 'host' },
      },
      signal: new AbortController().signal,
    })).resolves.toEqual({
      ok: true,
      result: { surface: 'api', caller: null, sessionId: null },
    });
    expect(actionInvocations).toBe(1);
  });

  it('defers and replays a materializationless bundled API Action with its admitting Workflow starter at its exact daemon placement', async () => {
    const previousSettings = process.env.HAPPIER_ACTIONS_SETTINGS_V1;
    let serviceOwners: ReturnType<typeof createProductionPluginInvocationServiceOwners> | undefined;
    process.env.HAPPIER_ACTIONS_SETTINGS_V1 = JSON.stringify({
      v: 1,
      actions: {
        'happier.channels/actions/inspect': {
          approvalRequiredSurfaces: ['api'],
        },
      },
    });
    try {
      let actionInvocations = 0;
      const runId = '99999999-9999-4999-8999-999999999999';
      let acceptedEnvelope: string | undefined;
      const run = WorkflowRunSummaryV1Schema.parse({ id: runId, sourceArtifactId: null,
        attentionRequired: false, failureUnseen: false, invocationAttentionRequired: false, attentionSeenFailureAt: null, finishedAt: null,
        ownerAccountId: 'account-1', visibleTeamId: null, origin: { kind: 'direct' }, state: 'queued', revision: 0,
        machineId: 'machine-local', workflowCustodyState: 'pending', originDeliveryAckRevision: null,
        availability: { pause: true, resumeBoundary: false, restoreWorkspace: false, cancel: true, inspectExecution: false, disabledReasons: [] },
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' });
      const workflowDeps: WorkflowAccountRunActionDeps = {
        resolveAccountId: async () => 'account-1',
        storage: { execute: async operation => {
          if (operation.operation === 'get') throw Object.assign(new Error('run_not_found'), { code: 'run_not_found' });
          if (operation.operation !== 'admit') throw new Error('unexpected_storage_operation');
          acceptedEnvelope = String(operation.acceptedEnvelope);
          return { kind: 'created', run };
        } },
        definitions: { get: async () => { throw new Error('inline_definition_only'); } },
        resolveEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
        normalizeAbsolutePath: directory => directory.startsWith('/') ? directory : null,
        randomBytes: () => { throw new Error('plain_account_does_not_need_keys'); },
        prepareWorkspace: async () => ({ ok: true, workspaceTarget: { project: { machineId: 'machine-local', directory: '/repo', checkoutRootPath: '/repo' } } }),
        resolveMaterializationContext: async () => ({ effects: { resolveTargetAvailability: async () => true } }),
      };
      const owner = createWorkflowAccountRunActionOwner(workflowDeps);
      serviceOwners = createProductionPluginInvocationServiceOwners({
        invokeContributedAction: async () => { throw new Error('no_further_plugin_edge'); },
        actionExecutor: { execute: async (actionId, input, context) => {
          if (actionId !== 'workflow.run.start') throw new Error('unexpected_host_action');
          return { ok: true, result: await owner.execute({ actionId, input: WorkflowRunStartRequestV1Schema.parse(input),
            context: { ...context, callerPermissionMode: 'default',
              externalActionTarget: { kind: 'machine', machineId: 'machine-local', project: { machineId: 'machine-local', directory: '/repo' } } } }) };
        } },
      });
      const runtime = createExternalActionRuntime(
        'global',
        'happier.channels',
        async context => {
          actionInvocations += 1;
          await context.services.actions.execute('workflow.run.start', { runId, source: { kind: 'inline', definition: {
            version: 1, blocks: [{ kind: 'wait', id: 'wait', document: { text: 'Review', references: [], attachments: [] } }],
          } } });
        },
        () => null,
        () => ({
          serverId: 'server-bundled',
          machineId: 'machine-local',
        }),
        undefined,
        serviceOwners,
      );
      const lease: PluginRuntimeRegistryLease = {
        registry: runtime,
        source: 'ephemeral',
        durableRevision: runtime.durableRevision ?? -1,
        release: async () => {},
      };
      let persisted: TargetActionApprovalRequestV1 | null = null;
      const targetActionApprovals = {
        targetActionApprovalsGet: async () => persisted,
        targetActionApprovalsUpdate: async (args: Readonly<{
          artifactId: string;
          request: TargetActionApprovalRequestV1;
        }>) => {
          persisted = args.request;
          return { ok: true as const };
        },
      };
      const invoke = createDaemonExternalActionContributedInvoker({
        acquireRuntimeRegistryLease: async () => lease,
        requestCurrentIntent: createTargetActionCurrentIntentAdapter({
          now: () => 1,
          create: async (request) => {
            persisted = request;
            return { artifactId: 'approval-bundled-1' };
          },
          read: async () => persisted,
        }),
      });

      await expect(invoke({
        action: { pluginId: 'happier.channels', localId: 'inspect' },
        input: {},
        approvalExecutionOrigin: {
          ...createApiActionApprovalOrigin(),
          serverId: 'server-bundled',
        },
        context: {
          surface: 'api',
          authority: 'account_automation',
          actionCaller: { kind: 'host' },
        },
        signal: new AbortController().signal,
      })).resolves.toEqual({
        ok: true,
        result: {
          kind: 'approval_request_created',
          artifactId: 'approval-bundled-1',
          actionId: 'action.invoke',
        },
      });
      expect(persisted).toMatchObject({
        sourceCustody: {
          kind: 'bundled_first_party',
          packagedRuntime: { kind: 'cli_version_root', versionRootId: 'fixture-cli-root' },
        },
        replayPlacement: {
          serverId: 'server-bundled',
          machineId: 'machine-local',
        },
      });

      const replay = createDaemonExternalActionContributedApprovalReplay({
        credentials: { token: 'daemon-token', encryption: null } as never,
        isApprovalExecutionOriginCurrent: async () => true,
        acquireRuntimeRegistryLease: async () => lease,
        targetActionApprovals,
        now: () => 2,
      });
      const replayed = await replay({
        artifactId: 'approval-bundled-1',
        decision: 'approve',
      });
      expect(replayed, JSON.stringify(replayed)).toMatchObject({
        ok: true,
        result: {
          ok: true,
          status: 'executed',
          execution: { ok: true },
        },
      });
      expect(actionInvocations).toBe(1);
      expect(openWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
        binding: { v: 1, purpose: 'accepted_snapshot', accountId: 'account-1', runId },
        envelope: parseWorkflowStoredContentEnvelopeV1(acceptedEnvelope),
      })).toMatchObject({ kind: 'available', content: { startedBy: 'user',
        authorization: { principal: { kind: 'plugin', pluginId: 'happier.channels', contributionLocalId: 'inspect' } } } });

      await expect(replay({
        artifactId: 'approval-bundled-1',
        decision: 'approve',
      })).resolves.toMatchObject({
        ok: true,
        result: { ok: true, status: 'executed' },
      });
      expect(actionInvocations).toBe(1);
    } finally {
      await serviceOwners?.dispose();
      if (previousSettings === undefined) delete process.env.HAPPIER_ACTIONS_SETTINGS_V1;
      else process.env.HAPPIER_ACTIONS_SETTINGS_V1 = previousSettings;
    }
  });

  it('replays the Channels conversation-start baseline with plugin authority instead of an unbound Agent scope', async () => {
    const sessionId = 'c1234567890123456789012345';
    const credentials = { token: 'daemon-token', encryption: null } as const;
    const session = createSessionRecordFixture({ id: sessionId, encryptionMode: 'plain' });
    externalActionTargetResolverMocks.fetchSessionById.mockResolvedValue(session);
    let transcriptReads = 0;
    // HTTP and approval persistence are the substituted system boundaries.
    // Replay, invocation binding, Actions admission and projection stay real.
    const http = vi.spyOn(axios, 'get').mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/encryption/currentness') {
        return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
      }
      if (path === '/v1/account/profile') return { status: 200, data: { id: 'account-1' } };
      if (path === `/v1/sessions/${sessionId}/messages`) {
        transcriptReads++;
        return { status: 200, data: { messages: [{ id: 'message-4', seq: 4, createdAt: 4,
          messageRole: 'user', externalShareableActor: 'machine',
          content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'Existing history' } } },
        }], hasMore: false, nextBeforeSeq: null, nextAfterSeq: null, publicationBlocked: false,
        externalShareableSnapshot: { turns: [] } } };
      }
      throw new Error(`Unexpected transcript HTTP path ${path}`);
    });
    const hostExecutor = createActionExecutor({ ...createUnavailableActionTransportDeps(),
      sessionTranscriptGet: async ({ sessionId: target, projection, cursor, limit, callerPluginId, signal }) =>
        await getSessionTranscript({ credentials, idOrPrefix: target, projection, cursor, limit, callerPluginId, signal }),
    });
    const services = createProductionPluginInvocationServiceOwners({ actionExecutor: hostExecutor,
      invokeContributedAction: async () => { throw new Error('No nested contributed Action expected'); } });
    let baseline: Awaited<ReturnType<typeof readConversationSessionProjectionNoHistoryBaseline>> | undefined;
    const runtime = createExternalActionRuntime('global', 'happier.channels', async context => {
      baseline = await readConversationSessionProjectionNoHistoryBaseline({ actions: context.services.actions,
        sessionId, signal: context.signal });
      if (baseline.kind !== 'ready') throw new PluginError({
        code: baseline.kind === 'unavailable' ? baseline.actionErrorCode ?? 'baseline_unavailable' : baseline.reason,
        message: 'Conversation start cannot establish its transcript baseline',
      });
    }, () => null, () => ({ serverId: 'server-external', machineId: 'machine-local' }),
    undefined, services, 'writesRemote', undefined, { localId: 'conversation/start-v1', surfaces: ['agent', 'plugin'] });
    const lease: PluginRuntimeRegistryLease = { registry: runtime, source: 'ephemeral',
      durableRevision: runtime.durableRevision ?? -1, release: async () => {} };
    let stored: TargetActionApprovalRequestV1 | null = null;
    const invoke = createDaemonExternalActionContributedInvoker({ acquireRuntimeRegistryLease: async () => lease,
      requestCurrentIntent: createTargetActionCurrentIntentAdapter({ now: () => 1,
        create: async request => { stored = TargetActionApprovalRequestV1Schema.parse(request); return { artifactId: 'channels-start-approval' }; },
        read: async () => stored,
      }) });
    const context = { ...buildWorkflowActionContext({ runId: '99999999-9999-4999-8999-999999999999',
      authorization: { principal: { kind: 'session', sessionId: 'origin' }, admittedPermissionCeiling: 'default' } }),
      serverId: 'server-external', runtimeAccountId: 'account-1', actionRequestId: 'workflow-start-request',
      actionRequestAttributionV1: { requestRef: 'workflow-start-request',
        requester: { serverId: 'server-external', accountId: 'account-1' },
        persona: { serverId: 'server-external', sessionId: 'origin' }, origin: null },
    };
    const unusedAuthorityRead = async (): Promise<never> => { throw new Error('Host acceptance has no delegated credential'); };
    const originCurrentness = createDaemonApprovalExecutionOriginCurrentness({
      accountId: 'account-1', machineId: 'machine-local', serverId: 'server-external',
      // Installed Home/Machine identity is the OS boundary; currentness owners remain real.
      resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: 'server-external', machineId: 'machine-local' }),
      resolveTarget: createDaemonExternalActionTargetResolver({ credentials }),
      isAccountCurrent: async () => (await axios.get<{ id: string }>('http://fixture-home/v1/account/profile')).data.id === 'account-1',
      listAccountApiTokens: unusedAuthorityRead,
    });
    try {
      const deferred = await invoke({ action: { pluginId: 'happier.channels', localId: 'conversation/start-v1' }, input: {},
        context, approvalExecutionOrigin: { v: 1, authority: 'account_automation', surface: 'agent',
          serverId: 'server-external', serverIdentityId: 'server-external', accountId: 'account-1', machineId: 'machine-local',
          target: { kind: 'machine', machineId: 'machine-local' }, actionId: 'action.invoke', requestId: 'workflow-start-request',
          caller: context.actionCaller!, callerPermissionMode: 'default',
          actionRequestAttributionV1: context.actionRequestAttributionV1 }, signal: new AbortController().signal,
      });
      expect(deferred, JSON.stringify(deferred)).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
      expect(transcriptReads).toBe(0);
      const replay = createDaemonExternalActionContributedApprovalReplay({ credentials,
        acquireRuntimeRegistryLease: async () => lease, isApprovalExecutionOriginCurrent: originCurrentness,
        targetActionApprovals: { targetActionApprovalsGet: async () => stored,
          targetActionApprovalsUpdate: async ({ request }) => { stored = TargetActionApprovalRequestV1Schema.parse(request); return { ok: true }; } },
      });
      const replayed = await replay({ artifactId: 'channels-start-approval', decision: 'approve' });
      expect(replayed, JSON.stringify(replayed)).toMatchObject({ ok: true,
        result: { status: 'executed', execution: { ok: true } } });
      expect(baseline).toEqual({ kind: 'ready', transcriptCursor: '4', lastScannedSeq: 4 });
      expect(transcriptReads).toBe(1);
      await expect(replay({ artifactId: 'channels-start-approval', decision: 'approve' }))
        .resolves.toMatchObject({ ok: true, result: { status: 'executed' } });
      expect(transcriptReads).toBe(1);
    } finally { http.mockRestore(); await runtime.dispose(); await services.dispose(); }
  });

  it('retains the typed provider cause when approved replay registry acquisition throws', async () => {
    const previousSettings = process.env.HAPPIER_ACTIONS_SETTINGS_V1;
    process.env.HAPPIER_ACTIONS_SETTINGS_V1 = JSON.stringify({ v: 1, actions: {
      'acme.managed/actions/inspect': { approvalRequiredSurfaces: ['api'] },
    } });
    const runtime = createExternalActionRuntime('global', 'acme.managed');
    const lease: PluginRuntimeRegistryLease = { registry: runtime, source: 'ephemeral',
      durableRevision: runtime.durableRevision ?? -1, release: async () => {} };
    let persisted: TargetActionApprovalRequestV1 | null = null;
    const nativeCause = { httpStatusClass: '4xx', code: 'forbidden' } as const;
    const diagnostic = vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => {});
    try {
      const defer = createDaemonExternalActionContributedInvoker({ acquireRuntimeRegistryLease: async () => lease,
        requestCurrentIntent: createTargetActionCurrentIntentAdapter({ now: () => 1,
          create: async request => { persisted = request; return { artifactId: 'provider-cause-replay' }; },
          read: async () => persisted,
        }) });
      await expect(defer({ action: { pluginId: 'acme.managed', localId: 'inspect' }, input: {},
        approvalExecutionOrigin: createApiActionApprovalOrigin('session-1'),
        context: { surface: 'api', authority: 'account_automation', actionCaller: { kind: 'host' }, defaultSessionId: 'session-1' },
        signal: new AbortController().signal,
      })).resolves.toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
      const replay = createDaemonExternalActionContributedApprovalReplay({
        credentials: { token: 'daemon-token', encryption: null },
        isApprovalExecutionOriginCurrent: async () => true,
        // The committed registry's filesystem/module acquisition is the failing boundary.
        acquireRuntimeRegistryLease: async () => { throw new PluginError({ code: 'provider_request_rejected',
          details: { nativeCause, diagnostic: 'token=fixture-private-token' } }); },
        targetActionApprovals: { targetActionApprovalsGet: async () => persisted,
          targetActionApprovalsUpdate: async ({ request }) => { persisted = request; return { ok: true }; } },
        now: () => 2,
      });
      const result = await replay({ artifactId: 'provider-cause-replay', decision: 'approve' });
      expect(result).toMatchObject({ ok: false, errorCode: 'provider_request_rejected',
        details: { code: 'provider_request_rejected', details: { nativeCause } } });
      expect(JSON.stringify(result)).not.toContain('fixture-private-token');
      expect(persisted).toMatchObject({ status: 'failed', execution: { ok: false, errorCode: 'provider_request_rejected' } });
      expect(diagnostic.mock.calls).toEqual([['[ExternalAction] Approved contributed Action replay failed',
        { code: 'provider_request_rejected' }]]);
    } finally {
      diagnostic.mockRestore();
      await runtime.dispose();
      if (previousSettings === undefined) delete process.env.HAPPIER_ACTIONS_SETTINGS_V1;
      else process.env.HAPPIER_ACTIONS_SETTINGS_V1 = previousSettings;
    }
  });

  it.each([
    { surface: 'api', authority: 'account_automation', changedAuthority: false, localId: 'inspect' },
    { surface: 'api', authority: 'present_user', changedAuthority: false, localId: 'inspect' },
    { surface: 'cli', authority: 'present_user', changedAuthority: false, localId: 'inspect' },
    { surface: 'cli', authority: 'present_user', changedAuthority: false, localId: 'actions/remove' },
    { surface: 'mcp', authority: 'account_automation', changedAuthority: false, localId: 'inspect' },
    { surface: 'agent', authority: 'account_automation', changedAuthority: false, localId: 'inspect' },
    { surface: 'cli', authority: 'present_user', changedAuthority: true, localId: 'inspect' },
  ] as const)('replays a managed $surface $localId target-action artifact with $authority authority exactly once at its stamped daemon (changed authority: $changedAuthority)', async ({ surface, authority, changedAuthority, localId }) => {
    const previousSettings = process.env.HAPPIER_ACTIONS_SETTINGS_V1;
    process.env.HAPPIER_ACTIONS_SETTINGS_V1 = JSON.stringify({
      v: 1,
      actions: {
        [`acme.managed/actions/${localId}`]: {
          approvalRequiredSurfaces: [surface],
        },
      },
    });
    try {
      let actionInvocations = 0;
      const runtime = createExternalActionRuntime('global', 'acme.managed', () => {
        actionInvocations += 1;
      }, undefined, undefined, undefined, undefined, 'safe', undefined,
      { localId, surfaces: ['cli', 'mcp', 'agent'] });
      const lease: PluginRuntimeRegistryLease = {
        registry: runtime,
        source: 'ephemeral',
        durableRevision: runtime.durableRevision ?? -1,
        release: async () => {},
      };
      let persisted: TargetActionApprovalRequestV1 | null = null;
      const targetActionApprovals = {
        targetActionApprovalsGet: async (args: Readonly<{ artifactId: string }>) => (
          args.artifactId === 'approval-api-exact-1' ? persisted : null
        ),
        targetActionApprovalsUpdate: async (args: Readonly<{
          artifactId: string;
          request: TargetActionApprovalRequestV1;
        }>) => {
          if (args.artifactId !== 'approval-api-exact-1') {
            return { ok: false as const, errorCode: 'not_found', error: 'artifact_not_found' };
          }
          persisted = args.request;
          return { ok: true as const };
        },
      };
      const requestCurrentIntent = createTargetActionCurrentIntentAdapter({
        now: () => 1,
        create: async (request) => {
          persisted = request;
          return { artifactId: 'approval-api-exact-1' };
        },
        read: async () => persisted,
      });
      const deferred = createDaemonExternalActionContributedInvoker({
        acquireRuntimeRegistryLease: async () => lease,
        requestCurrentIntent,
      });

      await expect(deferred({
        action: { pluginId: 'acme.managed', localId },
        input: { sessionId: 'session-to-unlink', entryId: '540' },
        approvalExecutionOrigin: { ...createApiActionApprovalOrigin('session-1'), surface, authority },
        context: {
          surface,
          authority,
          actionCaller: { kind: 'host' },
          defaultSessionId: 'session-1',
        },
        signal: new AbortController().signal,
      })).resolves.toEqual({
        ok: true,
        result: {
          kind: 'approval_request_created',
          artifactId: 'approval-api-exact-1',
          actionId: 'action.invoke',
        },
      });
      expect(actionInvocations).toBe(0);
      expect(persisted).toMatchObject({
        status: 'open',
        sourceCustody: {
          kind: 'managed',
          immutableGenerationId: 'fixture-immutable-generation',
          installSource: 'localPath',
        },
        replayPlacement: {
          serverId: 'server-external',
          machineId: 'machine-local',
          defaultSessionId: 'session-1',
        },
      });

      const replay = createDaemonExternalActionContributedApprovalReplay({
        credentials: { token: 'daemon-token', encryption: null } as never,
        isApprovalExecutionOriginCurrent: async () => true,
        acquireRuntimeRegistryLease: async () => lease,
        targetActionApprovals,
        now: () => 2,
      });

      if (!persisted) throw new Error('Expected the deferred approval');
      const currentApproval: TargetActionApprovalRequestV1 = persisted;
      const { secretInputPaths: _disclosure, ...legacyApproval } = currentApproval;
      persisted = legacyApproval;
      await expect(replay({ artifactId: 'approval-api-exact-1', decision: 'approve' }))
        .resolves.toMatchObject({ ok: false, errorCode: 'approval_context_unavailable' });
      expect(persisted.status).toBe('open');
      expect(actionInvocations).toBe(0);
      persisted = currentApproval;

      if (changedAuthority) {
        if (!currentApproval.executionOriginV1) throw new Error('Expected the admitting authority');
        persisted = { ...currentApproval, executionOriginV1: {
          ...currentApproval.executionOriginV1, authority: 'account_automation',
        } };
        await expect(replay({ artifactId: 'approval-api-exact-1', decision: 'approve' }))
          .resolves.toMatchObject({ ok: false, errorCode: 'plugin_action_current_intent_mismatch' });
        expect(persisted).toMatchObject({ status: 'failed', execution: { ok: false } });
        expect(actionInvocations).toBe(0);
        return;
      }

      await expect(replay({
        artifactId: 'approval-api-exact-1',
        decision: 'approve',
      })).resolves.toMatchObject({
        ok: true,
        result: {
          ok: true,
          status: 'executed',
          execution: {
            ok: true,
            result: { surface, caller: null, sessionId: 'session-1' },
          },
        },
      });
      expect(actionInvocations).toBe(1);
      expect(persisted).toMatchObject({
        status: 'executed',
        decision: { kind: 'approve' },
        execution: {
          ok: true,
          result: { surface, caller: null, sessionId: 'session-1' },
        },
      });

      await expect(replay({
        artifactId: 'approval-api-exact-1',
        decision: 'approve',
      })).resolves.toMatchObject({
        ok: true,
        result: { ok: true, status: 'executed' },
      });
      expect(actionInvocations).toBe(1);
    } finally {
      if (previousSettings === undefined) delete process.env.HAPPIER_ACTIONS_SETTINGS_V1;
      else process.env.HAPPIER_ACTIONS_SETTINGS_V1 = previousSettings;
    }
  });

  it('reconstructs an immutable PAT context and installation-key signer for contributed-Action replay', async () => {
    const previousSettings = process.env.HAPPIER_ACTIONS_SETTINGS_V1;
    process.env.HAPPIER_ACTIONS_SETTINGS_V1 = JSON.stringify({
      v: 1,
      actions: {
        'acme.external/actions/inspect': {
          approvalRequiredSurfaces: ['api'],
        },
      },
    });
    try {
    const installationKeyPair = tweetnacl.sign.keyPair();
    const outerInput = {
      action: { pluginId: 'acme.external', localId: 'inspect' },
      input: {},
    } as const;
    const target = { kind: 'machine' as const, machineId: 'machine-local' };
    const approvedGrant = {
      ...API_TOKEN_FULL_GRANT_V1,
      actions: { families: [], ids: ['acme.external/actions/inspect'] },
    };
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({
      v: 1 as const,
      token: 'home-signed-external-invocation',
      binding: {
        serverIdentityId: 'server-external',
        accountId: 'account-1',
        custodianAccountId: 'account-1',
        installationId: 'machine-installation-1',
        principalId: 'principal-1',
        credentialId: '11111111-1111-4111-8111-111111111111',
        machineId: 'machine-local',
        actionId: 'action.invoke',
        requestId: 'request-1',
        requestEnvelopeDigest: 'A'.repeat(43),
        grant: approvedGrant,
        target,
      },
    });
    if (!('grant' in authorization.binding)) throw new Error('Expected canonical PAT authorization');
    const approvalExecutionOrigin: ApprovalExecutionOriginV1 = {
      ...createApiActionApprovalOrigin(),
      serverIdentityId: authorization.binding.serverIdentityId,
      externalActionExecutionAuthorization: authorization,
      externalActionInputSignature: signExternalActionApprovalInputV1({
        authorizationToken: authorization.token,
        actionId: 'action.invoke',
        target,
        input: outerInput,
        privateKey: installationKeyPair.secretKey,
      }),
    };
    const parsedOrigin = ApprovalExecutionOriginV1Schema.safeParse(approvalExecutionOrigin);
    expect(parsedOrigin.success, JSON.stringify(parsedOrigin.success ? {} : parsedOrigin.error.issues.map(({ code, path }) => ({ code, path })))).toBe(true);
    let replaySeed: PluginActionsServiceSeed | null = null;
    const runtime = createExternalActionRuntime(
      'global',
      'acme.external',
      undefined,
      undefined,
      undefined,
      (seed) => { replaySeed = seed; },
    );
    const lease: PluginRuntimeRegistryLease = {
      registry: runtime,
      source: 'ephemeral',
      durableRevision: runtime.durableRevision ?? -1,
      release: async () => {},
    };
    let persisted: TargetActionApprovalRequestV1 | null = null;
    const targetActionApprovals = {
      targetActionApprovalsGet: async () => persisted,
      targetActionApprovalsUpdate: async (args: Readonly<{
        artifactId: string;
        request: TargetActionApprovalRequestV1;
      }>) => {
        persisted = args.request;
        return { ok: true as const };
      },
    };
    const deferred = createDaemonExternalActionContributedInvoker({
      acquireRuntimeRegistryLease: async () => lease,
      requestCurrentIntent: createTargetActionCurrentIntentAdapter({
        now: () => 1,
        create: async (request) => {
          persisted = request;
          return { artifactId: 'approval-external-pat-replay' };
        },
        read: async () => persisted,
      }),
    });

    const deferredResult = await deferred({
      action: outerInput.action,
      input: outerInput.input,
      approvalExecutionOrigin,
      context: {
        surface: 'api',
        authority: 'account_automation',
        actionCaller: { kind: 'host' },
        serverId: 'server-external',
        serverIdentityId: 'server-external',
        actionRequestId: 'request-1',
        externalActionCredential: {
          accountId: 'account-1',
          principalId: 'principal-1',
          credentialId: '11111111-1111-4111-8111-111111111111',
          grant: approvedGrant,
        },
        externalActionExecutionAuthorization: authorization,
        externalActionTarget: target,
      },
      signal: new AbortController().signal,
    });
    expect(deferredResult, JSON.stringify({ ok: deferredResult.ok,
      ...(!deferredResult.ok ? { errorCode: deferredResult.errorCode } : {}) })).toMatchObject({
      ok: true,
      result: { kind: 'approval_request_created', artifactId: 'approval-external-pat-replay' },
    });

    const replay = createDaemonExternalActionContributedApprovalReplay({
      credentials: { token: 'daemon-token', encryption: null } as never,
      isApprovalExecutionOriginCurrent: async () => true,
      acquireRuntimeRegistryLease: async () => lease,
      targetActionApprovals,
      readInstallationIdentity: () => ({
        version: 1,
        installationId: 'machine-installation-1',
        createdAt: 1,
        publicKey: encodeBase64(installationKeyPair.publicKey, 'base64url'),
        privateKey: encodeBase64(installationKeyPair.secretKey, 'base64url'),
      }),
      now: () => 2,
    });
    await expect(replay({
      artifactId: 'approval-external-pat-replay',
      decision: 'approve',
    })).resolves.toMatchObject({ ok: true, result: { status: 'executed' } });

    expect(replaySeed).not.toBeNull();
    const context = replaySeed!.externalActionContext!;
    expect(context.externalActionCredential.grant).toEqual(authorization.binding.grant);
    expect(context.externalActionCredential.grant.approve).toBe(false);
    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context.externalActionCredential)).toBe(true);
    expect(Object.isFrozen(context.externalActionExecutionAuthorization)).toBe(true);
    expect(Object.isFrozen(context.externalActionExecutionAuthorization.binding)).toBe(true);
    expect(Object.isFrozen(context.externalActionExecutionAuthorization.binding.target)).toBe(true);
    expect(Object.isFrozen(context.externalActionTarget)).toBe(true);
    const effectInput = { v: 1, teamId: 'team-1' };
    const signature = context.signExternalActionApprovalInput!({
      actionId: 'teams.archive',
      input: effectInput,
      target,
      authorization,
    });
    expect(verifyExternalActionApprovalInputV1({
      authorizationToken: authorization.token,
      actionId: 'teams.archive',
      target,
      input: effectInput,
      publicKey: installationKeyPair.publicKey,
      signature,
    })).toBe(true);
    } finally {
      if (previousSettings === undefined) delete process.env.HAPPIER_ACTIONS_SETTINGS_V1;
      else process.env.HAPPIER_ACTIONS_SETTINGS_V1 = previousSettings;
    }
  });

  it.each(['unavailable', 'transport-unavailable', 'stale'] as const)(
    'classifies contributed approval origin currentness before execution custody (%s)',
    async scenario => {
    const previousSettings = process.env.HAPPIER_ACTIONS_SETTINGS_V1;
    process.env.HAPPIER_ACTIONS_SETTINGS_V1 = JSON.stringify({
      v: 1,
      actions: {
        'acme.external/actions/inspect': {
          approvalRequiredSurfaces: ['api'],
        },
      },
    });
    try {
      let actionInvocations = 0;
      let homeAvailable = false;
      const runtime = createExternalActionRuntime(
        'global',
        'acme.external',
        () => { actionInvocations += 1; },
      );
      const lease: PluginRuntimeRegistryLease = {
        registry: runtime,
        source: 'ephemeral',
        durableRevision: runtime.durableRevision ?? -1,
        release: async () => {},
      };
      let persisted: TargetActionApprovalRequestV1 | null = null;
      const targetActionApprovals = {
        targetActionApprovalsGet: async () => persisted,
        targetActionApprovalsUpdate: async (args: Readonly<{
          artifactId: string;
          request: TargetActionApprovalRequestV1;
        }>) => {
          persisted = TargetActionApprovalRequestV1Schema.parse(args.request);
          return { ok: true as const };
        },
      };
      const defer = createDaemonExternalActionContributedInvoker({
        acquireRuntimeRegistryLease: async () => lease,
        requestCurrentIntent: createTargetActionCurrentIntentAdapter({
          now: () => 1,
          create: async (request) => {
            persisted = TargetActionApprovalRequestV1Schema.parse(request);
            return { artifactId: 'approval-api-home-recovery-1' };
          },
          read: async () => persisted,
        }),
      });
      await expect(defer({
        action: { pluginId: 'acme.external', localId: 'inspect' },
        input: {},
        approvalExecutionOrigin: createApiActionApprovalOrigin(),
        context: {
          surface: 'api',
          authority: 'account_automation',
          actionCaller: { kind: 'host' },
        },
        signal: new AbortController().signal,
      })).resolves.toMatchObject({
        ok: true,
        result: { kind: 'approval_request_created', artifactId: 'approval-api-home-recovery-1' },
      });
      const replay = createDaemonExternalActionContributedApprovalReplay({
        credentials: { token: 'daemon-token', encryption: null } as never,
        isApprovalExecutionOriginCurrent: async ({ reportStale }) => {
          if (scenario !== 'stale' && !homeAvailable) {
            throw Object.assign(new Error('project_requester_home_unavailable'), {
              code: scenario === 'unavailable' ? 'project_requester_home_unavailable' : 'ECONNRESET',
            });
          }
          if (scenario === 'stale') reportStale?.('origin_not_current');
          return scenario !== 'stale';
        },
        acquireRuntimeRegistryLease: async () => lease,
        targetActionApprovals,
        now: () => 2,
      });

      await expect(replay({ artifactId: 'approval-api-home-recovery-1', decision: 'approve' }))
        .resolves.toMatchObject({ ok: false, errorCode: scenario === 'unavailable'
          ? 'project_requester_home_unavailable' : scenario === 'transport-unavailable' ? 'server_unreachable' : 'approval_stale' });
      expect(persisted).toMatchObject({ status: scenario === 'stale' ? 'failed' : 'approved',
        decision: { kind: 'approve' } });
      expect(actionInvocations).toBe(0);

      if (scenario === 'stale') {
        await expect(replay({ artifactId: 'approval-api-home-recovery-1', decision: 'approve' }))
          .resolves.toMatchObject({ ok: true, result: { status: 'failed' } });
        expect(actionInvocations).toBe(0);
        return;
      }
      homeAvailable = true;
      await expect(replay({ artifactId: 'approval-api-home-recovery-1', decision: 'approve' }))
        .resolves.toMatchObject({ ok: true, result: { status: 'executed' } });
      expect(persisted).toMatchObject({ status: 'executed' });
      expect(actionInvocations).toBe(1);
    } finally {
      if (previousSettings === undefined) delete process.env.HAPPIER_ACTIONS_SETTINGS_V1;
      else process.env.HAPPIER_ACTIONS_SETTINGS_V1 = previousSettings;
    }
  });

  it.each([false, true])('admits one target effect across independent concurrent executors (unknown write fails: %s)', async unknownWriteFails => {
    const previousSettings = process.env.HAPPIER_ACTIONS_SETTINGS_V1;
    process.env.HAPPIER_ACTIONS_SETTINGS_V1 = JSON.stringify({
      v: 1,
      actions: {
        'acme.external/actions/inspect': {
          approvalRequiredSurfaces: ['api'],
        },
      },
    });
    let releaseActionInvocation: () => void = () => {};
    try {
      let actionInvocations = 0;
      let firstActionInvocationStarted!: () => void;
      const firstActionInvocation = new Promise<void>((resolve) => {
        firstActionInvocationStarted = resolve;
      });
      const actionInvocationRelease = new Promise<void>((resolve) => {
        releaseActionInvocation = resolve;
      });
      const invocationIds: (string | undefined)[] = [];
      const runtime = createExternalActionRuntime('global', 'acme.external', async (context) => {
        invocationIds.push(context.invocationId);
        actionInvocations += 1;
        if (actionInvocations === 1) firstActionInvocationStarted();
        await actionInvocationRelease;
      });
      const lease: PluginRuntimeRegistryLease = {
        registry: runtime,
        source: 'ephemeral',
        durableRevision: runtime.durableRevision ?? -1,
        release: async () => {},
      };
      let persisted: TargetActionApprovalRequestV1 | null = null;
      let failTerminalWrite = false;
      const targetActionApprovals = {
        targetActionApprovalsGet: async () => persisted,
        targetActionApprovalsUpdate: async (args: Readonly<{
          artifactId: string;
          request: TargetActionApprovalRequestV1;
        }>) => {
          const prior = persisted;
          if (failTerminalWrite
            && (args.request.status === 'executed' || args.request.status === 'failed'
              || unknownWriteFails && args.request.status === 'outcome_unknown')) {
            return { ok: false as const, errorCode: 'conflict', error: 'synthetic_terminal_write_failure' };
          }
          if (!prior) throw new Error('Missing admitted approval');
          const transition = admitTargetActionApprovalTransition(prior, args.request);
          if (!transition.ok) return transition;
          persisted = TargetActionApprovalRequestV1Schema.parse(args.request);
          return { ok: true as const };
        },
      };
      const defer = createDaemonExternalActionContributedInvoker({
        acquireRuntimeRegistryLease: async () => lease,
        requestCurrentIntent: createTargetActionCurrentIntentAdapter({
          now: () => 1,
          create: async (request) => {
            persisted = request;
            return { artifactId: 'approval-api-concurrent-1' };
          },
          read: async () => persisted,
        }),
      });
      await defer({
        action: { pluginId: 'acme.external', localId: 'inspect' },
        input: {},
        approvalExecutionOrigin: createApiActionApprovalOrigin(),
        context: {
          surface: 'api',
          authority: 'account_automation',
          actionCaller: { kind: 'host' },
        },
        signal: new AbortController().signal,
      });
      const createReplay = () => createDaemonExternalActionContributedApprovalReplay({
        credentials: { token: 'daemon-token', encryption: null } as never,
        isApprovalExecutionOriginCurrent: async () => true,
        acquireRuntimeRegistryLease: async () => lease,
        targetActionApprovals,
        now: () => 2,
      });
      const first = createReplay()({
        artifactId: 'approval-api-concurrent-1',
        decision: 'approve',
      });
      await firstActionInvocation;
      const second = createReplay()({ artifactId: 'approval-api-concurrent-1', decision: 'approve' });

      expect(actionInvocations).toBe(1);
      releaseActionInvocation();
      await expect(Promise.all([first, second])).resolves.toEqual([
        expect.objectContaining({ ok: true, result: { ok: true, status: 'executed', execution: expect.any(Object) } }),
        { ok: false, errorCode: 'approval_execution_outcome_unknown', error: 'approval_execution_outcome_unknown' },
      ]);
      expect(actionInvocations).toBe(1);
      await vi.waitFor(() => expect(persisted).toMatchObject({ status: 'executed' }));
      expect(persisted).toMatchObject({
        status: 'executed',
        decision: { kind: 'approve' },
        execution: { ok: true },
      });
      const { execution: _priorExecution, ...unsettled } = persisted!;
      persisted = { ...unsettled, status: 'approved', updatedAtMs: 3 };
      failTerminalWrite = true;
      await expect(createReplay()({ artifactId: 'approval-api-concurrent-1', decision: 'approve' }))
        .resolves.toEqual({ ok: false, errorCode: 'approval_execution_outcome_unknown', error: 'approval_execution_outcome_unknown' });
      expect(actionInvocations).toBe(2);
      expect(invocationIds).toEqual(['approval-api-concurrent-1', 'approval-api-concurrent-1']);
      expect(persisted).toMatchObject(unknownWriteFails ? { status: 'executing' }
        : { status: 'outcome_unknown', execution: {
          ok: false, effectAttempted: true, errorCode: 'approval_execution_outcome_unknown',
        } });
      await expect(createReplay()({ artifactId: 'approval-api-concurrent-1', decision: 'approve' }))
        .resolves.toEqual({ ok: false, errorCode: 'approval_execution_outcome_unknown', error: 'approval_execution_outcome_unknown' });
      expect(actionInvocations).toBe(2);
    } finally {
      releaseActionInvocation();
      if (previousSettings === undefined) delete process.env.HAPPIER_ACTIONS_SETTINGS_V1;
      else process.env.HAPPIER_ACTIONS_SETTINGS_V1 = previousSettings;
    }
  });

  it('evaluates a conflicting concurrent rejection after the in-flight approval settles', async () => {
    const previousSettings = process.env.HAPPIER_ACTIONS_SETTINGS_V1;
    process.env.HAPPIER_ACTIONS_SETTINGS_V1 = JSON.stringify({
      v: 1,
      actions: {
        'acme.external/actions/inspect': {
          approvalRequiredSurfaces: ['api'],
        },
      },
    });
    let releaseActionInvocation: () => void = () => {};
    try {
      let actionInvocations = 0;
      let actionInvocationStarted!: () => void;
      const actionStarted = new Promise<void>((resolve) => {
        actionInvocationStarted = resolve;
      });
      const actionRelease = new Promise<void>((resolve) => {
        releaseActionInvocation = resolve;
      });
      const runtime = createExternalActionRuntime('global', 'acme.external', async () => {
        actionInvocations += 1;
        actionInvocationStarted();
        await actionRelease;
      });
      const lease: PluginRuntimeRegistryLease = {
        registry: runtime,
        source: 'ephemeral',
        durableRevision: runtime.durableRevision ?? -1,
        release: async () => {},
      };
      let persisted: TargetActionApprovalRequestV1 | null = null;
      const targetActionApprovals = {
        targetActionApprovalsGet: async () => persisted,
        targetActionApprovalsUpdate: async (args: Readonly<{
          artifactId: string;
          request: TargetActionApprovalRequestV1;
        }>) => {
          persisted = args.request;
          return { ok: true as const };
        },
      };
      const defer = createDaemonExternalActionContributedInvoker({
        acquireRuntimeRegistryLease: async () => lease,
        requestCurrentIntent: createTargetActionCurrentIntentAdapter({
          now: () => 1,
          create: async (request) => {
            persisted = request;
            return { artifactId: 'approval-api-conflict-1' };
          },
          read: async () => persisted,
        }),
      });
      await defer({
        action: { pluginId: 'acme.external', localId: 'inspect' },
        input: {},
        approvalExecutionOrigin: createApiActionApprovalOrigin(),
        context: {
          surface: 'api',
          authority: 'account_automation',
          actionCaller: { kind: 'host' },
        },
        signal: new AbortController().signal,
      });
      const replay = createDaemonExternalActionContributedApprovalReplay({
        credentials: { token: 'daemon-token', encryption: null } as never,
        isApprovalExecutionOriginCurrent: async () => true,
        acquireRuntimeRegistryLease: async () => lease,
        targetActionApprovals,
        now: () => 2,
      });

      const approve = replay({ artifactId: 'approval-api-conflict-1', decision: 'approve' });
      await actionStarted;
      const reject = replay({ artifactId: 'approval-api-conflict-1', decision: 'reject' });
      releaseActionInvocation();

      await expect(approve).resolves.toMatchObject({
        ok: true,
        result: { ok: true, status: 'executed' },
      });
      await expect(reject).resolves.toEqual({
        ok: false,
        errorCode: 'approval_not_open',
        error: 'approval_not_open',
      });
      expect(actionInvocations).toBe(1);
      expect(persisted).toMatchObject({
        status: 'executed',
        decision: { kind: 'approve' },
      });
    } finally {
      releaseActionInvocation();
      if (previousSettings === undefined) delete process.env.HAPPIER_ACTIONS_SETTINGS_V1;
      else process.env.HAPPIER_ACTIONS_SETTINGS_V1 = previousSettings;
    }
  });

  it.each(['policy', 'version', 'readoption', 'input declaration', 'result declaration', 'origin', 'transport_unknown'] as const)(
    'executes approved operands once after plugin metadata changes: %s', async change => {
    const previousSettings = process.env.HAPPIER_ACTIONS_SETTINGS_V1;
    process.env.HAPPIER_ACTIONS_SETTINGS_V1 = JSON.stringify({
      v: 1,
      actions: {
        'acme.external/actions/inspect': {
          approvalRequiredSurfaces: ['api'],
        },
      },
    });
    try {
      let actionInvocations = 0;
      const onInvocation = () => {
        actionInvocations += 1;
        if (change === 'transport_unknown') throw new PluginError({ code: 'RPC_OUTCOME_UNKNOWN', message: 'RPC_OUTCOME_UNKNOWN' });
      };
      const occurrenceId = 'acme.external:1' as PluginRuntimeOccurrenceId;
      const runtime = createExternalActionRuntime('global', 'acme.external', onInvocation,
        undefined, undefined, undefined, undefined, 'safe', undefined, { occurrenceId });
      let lease: PluginRuntimeRegistryLease = {
        registry: runtime,
        source: 'ephemeral',
        durableRevision: runtime.durableRevision ?? -1,
        release: async () => {},
      };
      let persisted: TargetActionApprovalRequestV1 | null = null;
      const targetActionApprovals = {
        targetActionApprovalsGet: async () => persisted,
        targetActionApprovalsUpdate: async (args: Readonly<{
          artifactId: string;
          request: TargetActionApprovalRequestV1;
        }>) => {
          persisted = args.request;
          return { ok: true as const };
        },
      };
      const defer = createDaemonExternalActionContributedInvoker({
        acquireRuntimeRegistryLease: async () => lease,
        requestCurrentIntent: createTargetActionCurrentIntentAdapter({
          now: () => 1,
          create: async (request) => {
            persisted = TargetActionApprovalRequestV1Schema.parse(JSON.parse(JSON.stringify(request)));
            return { artifactId: 'approval-api-stale-1' };
          },
          read: async () => persisted,
        }),
      });
      await defer({
        action: { pluginId: 'acme.external', localId: 'inspect' },
        input: {},
        approvalExecutionOrigin: createApiActionApprovalOrigin(),
        context: {
          surface: 'api',
          authority: 'account_automation',
          actionCaller: { kind: 'host' },
        },
        signal: new AbortController().signal,
      });
      expect(persisted).toMatchObject({
        sourceCustody: {
          kind: 'development',
          registeredRootId: 'fixture-root:acme.external',
        },
      });

      if (change === 'policy') {
        // Changing future admission policy does not withdraw settled consent.
        process.env.HAPPIER_ACTIONS_SETTINGS_V1 = JSON.stringify({ v: 1, actions: {} });
      } else {
        runtime.targetActionInvocations?.dispose();
        // A new daemon epoch can allocate the same occurrence spelling and root.
        const successor = createExternalActionRuntime('global', 'acme.external', onInvocation,
          undefined, undefined, undefined, undefined, 'safe', undefined, {
            occurrenceId: change === 'readoption' ? createPluginRuntimeOccurrenceId('acme.external') : occurrenceId,
            ...(change === 'version' ? { pluginVersion: '2.0.0' } : {}),
            ...(change === 'input declaration' ? {
              inputSchema: { type: 'object', properties: { target: { type: 'string' } }, additionalProperties: false },
            } : {}),
            ...(change === 'result declaration' ? { resultSchema: { type: 'object', additionalProperties: true } } : {}),
            ...(change === 'origin' ? { sourceCustody: { kind: 'development', registeredRootId: 'another-install-root' } as const } : {}),
          });
        lease = { ...lease, registry: successor };
      }
      const replay = createDaemonExternalActionContributedApprovalReplay({
        credentials: { token: 'daemon-token', encryption: null } as never,
        isApprovalExecutionOriginCurrent: async () => true,
        acquireRuntimeRegistryLease: async () => lease,
        targetActionApprovals,
        now: () => 2,
      });

      const result = await replay({
        artifactId: 'approval-api-stale-1',
        decision: 'approve',
      });
      if (change !== 'transport_unknown') {
        expect(result).toMatchObject({ ok: true, result: { status: 'executed' } });
        expect(actionInvocations).toBe(1);
        expect(persisted).toMatchObject({ status: 'executed', execution: { ok: true } });
        await expect(replay({ artifactId: 'approval-api-stale-1', decision: 'approve' }))
          .resolves.toMatchObject({ ok: true, result: { status: 'executed' } });
        expect(actionInvocations).toBe(1);
        return;
      }
      if (change === 'transport_unknown') {
        expect(result).toMatchObject({ ok: false, errorCode: 'approval_execution_outcome_unknown' });
        expect(persisted).toMatchObject({ status: 'outcome_unknown', execution: {
          ok: false, effectAttempted: true, errorCode: 'approval_execution_outcome_unknown',
        } });
        await expect(replay({ artifactId: 'approval-api-stale-1', decision: 'approve' }))
          .resolves.toMatchObject({ ok: false, errorCode: 'approval_execution_outcome_unknown' });
        expect(actionInvocations).toBe(1);
        return;
      }
    } finally {
      if (previousSettings === undefined) delete process.env.HAPPIER_ACTIONS_SETTINGS_V1;
      else process.env.HAPPIER_ACTIONS_SETTINGS_V1 = previousSettings;
    }
  });

  it('rejects a stamped API target-action artifact without acquiring its executor', async () => {
    // Simulates the pre-origin development artifact shape. Current writers
    // cannot construct it, but replay must still fail closed before a lease.
    let persisted = {
      v: 1,
      kind: 'plugin_target_action',
      status: 'open',
      createdAtMs: 1,
      updatedAtMs: 1,
      createdBy: { surface: 'system' },
      requestedSurface: 'api',
      qualifiedActionId: 'acme.external/actions/inspect',
      input: {},
      sourceCustody: { kind: 'development', registeredRootId: 'fixture-root' },
      policyFingerprint: 'a'.repeat(64),
      subjectFingerprint: 'b'.repeat(64),
      replayPlacement: {
        serverId: 'server-external',
        machineId: 'machine-local',
      },
      summary: 'Inspect',
    } as TargetActionApprovalRequestV1;
    const acquireRuntimeRegistryLease = vi.fn(async () => {
      throw new Error('rejection_must_not_acquire_a_runtime_lease');
    });
    const targetActionApprovalsUpdate = vi.fn(async (args: Readonly<{
      artifactId: string;
      request: TargetActionApprovalRequestV1;
    }>) => {
      persisted = args.request;
      return { ok: true as const };
    });
    const replay = createDaemonExternalActionContributedApprovalReplay({
      credentials: { token: 'daemon-token', encryption: null } as never,
      acquireRuntimeRegistryLease,
      targetActionApprovals: {
        targetActionApprovalsGet: async () => persisted,
        targetActionApprovalsUpdate,
      },
      now: () => 2,
    });

    await expect(replay({
      artifactId: 'approval-api-reject-1',
      decision: 'reject',
      callerGrant: { ...API_TOKEN_FULL_GRANT_V1, approve: true, targets: { sessions: ['other-session'], machines: [] } },
    })).resolves.toMatchObject({ ok: false, errorCode: 'credential_scope_denied' });
    expect(targetActionApprovalsUpdate).not.toHaveBeenCalled();
    expect(acquireRuntimeRegistryLease).not.toHaveBeenCalled();

    await expect(replay({
      artifactId: 'approval-api-reject-1',
      decision: 'reject',
    })).resolves.toEqual({
      ok: true,
      result: { ok: true, status: 'rejected' },
    });
    expect(acquireRuntimeRegistryLease).not.toHaveBeenCalled();
    expect(targetActionApprovalsUpdate).toHaveBeenCalledOnce();
    expect(persisted).toMatchObject({
      status: 'rejected',
      decision: { kind: 'reject', decidedAtMs: 2 },
    });
  });
});
