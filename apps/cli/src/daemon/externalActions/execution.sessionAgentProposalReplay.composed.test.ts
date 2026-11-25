import axios from 'axios';
import * as actionAuthorization from '@/api/externalActionExecutionAuthorization';
import { readRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import { expect, it, onTestFinished, vi } from 'vitest';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import {
  ExternalActionExecutionAuthorizationRequestV1Schema,
  ExternalActionExecutionAuthorizationV1Schema,
  ExternalActionRequestEnvelopeSchema,
  projectExternalActionApprovalDecisionAdmissionV1,
} from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { AUTOMATION_ACTION_INDEX_HTTP_PATH_V1, ActionAutomationIndexV1Schema } from '@happier-dev/protocol/automations/automationActionTriggerV1';
import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import { readCarrierMutation } from '@/api/artifacts/accountArtifactStore.testkit';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { configuration } from '@/configuration';
import {
  createAgentRuntimeDaemonServiceAuthorityPath,
  publishAgentRuntimeDaemonServiceAuthority,
} from '@/daemon/agentRuntime/sessionBridgeAuthorization';
import type { startDaemonControlServer } from '@/daemon/controlServer';
import { createInstalledProjectAgentDaemonFixture } from '@/daemon/testkit/installedProjectAgentDaemonFixture';
import { resetServerFeaturesClientForTests } from '@/features/serverFeaturesClient';
import { ensureCliActionPolicySettings } from '@/session/actions/ensureCliActionPolicySettings';
import { executeExternalAction } from './executeExternalAction';

const boundary = vi.hoisted(() => ({
  control: null as Parameters<typeof startDaemonControlServer>[0] | null,
}));
// The private OS listener and Home HTTP are the boundaries. Agent dispatch, the
// Agent's explicit proposal, the daemon's approval replay and its header owner stay real.
vi.mock('@/daemon/controlServer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/daemon/controlServer')>()),
  startDaemonControlServer: async (
    input: Parameters<typeof startDaemonControlServer>[0],
  ) => {
    boundary.control = input;
    return { port: 43129, stop: async () => {} };
  },
}));

const homeId = 'srv_session_agent_proposal';
const homeUrl = 'https://session-home.test';

/**
 * W18B2 5a: an Agent in a running Session proposes `session.model.set` through
 * `approval.request.create`; the same Account approves it at the installed daemon.
 * Home mints the proposal root (`approval.request.create`, Session origin); the
 * replayed model write is refused before any Home effect and its receipt names why.
 */
it.each([
  { actionId: 'session.model.set', failureMessage: 'External Action authorization unavailable: approval_replay_mismatch' },
  { actionId: 'machines.services.list', failureMessage: 'External Action authorization unavailable: approval_replay_mismatch' },
] as const)('names the refusal when an approved Agent proposal cannot dispatch $actionId', async ({ actionId, failureMessage }) => {
  onTestFinished(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    boundary.control = null;
    resetServerFeaturesClientForTests();
  });
  const credentials = {
    token: `e30.${Buffer.from(
      JSON.stringify({
        sub: 'requester',
        tokenEpoch: 0,
        provenance: { v: 1, kind: 'terminal', authority: 'account_automation' },
      }),
    ).toString('base64url')}.signature`,
    encryption: null,
    credentialProvenance: 'stored_session' as const,
  };
  const h = await createInstalledProjectAgentDaemonFixture(
    () => boundary.control,
    undefined,
    true,
    undefined,
    undefined,
    {
      ordinaryAccountSession: true,
      credentials,
      externalActionAccountId: 'requester',
      accountActionCredentials: credentials,
      requesterCredentials: credentials,
      homeServerIdentityId: homeId,
      machineAccess: { custodianAccountId: 'requester', role: 'manage' },
      accountSettings: {
        actionsSettingsV1: normalizeActionsSettingsV1({ v: 1 }),
      },
      resolveServerFeaturesSnapshot: () => ({
        status: 'ready',
        features: FeaturesResponseSchema.parse({
          features: {},
          capabilities: {},
        }),
      }),
      resolveCurrentMachineExecutionOriginContext: async () => ({
        serverIdentityId: homeId,
        machineId: 'machine',
      }),
    },
  );
  // The Session is running (a person resumed it); replay rechecks its live runner authority.
  const authority = {
    happyHomeDir: h.f.directory,
    publicReleaseRing: configuration.publicReleaseRing,
  };
  const bridge = await publishAgentRuntimeDaemonServiceAuthority({
    ...authority,
    path: await createAgentRuntimeDaemonServiceAuthorityPath(authority),
    sessionId: h.sessionId,
    runner: h.runner,
    retainedAgent: h.retainedAgent,
    httpPort: 43129,
    capability: 'a'.repeat(43),
  });
  h.tracked.agentRuntimeDaemonServiceAuthorityFilePath = bridge.path;
  h.tracked.agentRuntimeDaemonServiceCapabilityHash = bridge.capabilityDigest;
  const owner = h.daemon.externalActionIngressOwner;
  if (!owner) throw new Error('Missing installed external Action owner');
  const homeWrite = vi.mocked(axios.post).getMockImplementation();
  const homeRead = vi.mocked(axios.get).getMockImplementation();
  if (!homeWrite || !homeRead)
    throw new Error('Missing Home transport boundary');
  const homeFetch = globalThis.fetch;
  vi.stubGlobal('fetch', async (...args: Parameters<typeof fetch>) => {
    const input = args[0];
    const url = new URL(
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    // No Automation checks this Action.
    if (url.pathname === AUTOMATION_ACTION_INDEX_HTTP_PATH_V1)
      return Response.json(ActionAutomationIndexV1Schema.parse({ v: 1, rows: [] }));
    if (
      url.pathname === '/v1/features/authenticated' ||
      url.pathname === '/v1/features'
    )
      return Response.json(
        FeaturesResponseSchema.parse({
          features: {},
          capabilities: { serverIdentity: { serverIdentityId: homeId } },
        }),
      );
    return await homeFetch(...args);
  });
  const artifacts = new Map<string, Record<string, unknown>>();
  const sessionWrites: string[] = [];
  const observations: Array<{
    rootAction: string;
    sourceMachine: string | undefined;
    boundMachine: string;
    credentialAvailable: boolean;
    reason: string | null;
  }> = [];
  const resolveHeaders = actionAuthorization.resolveExternalActionServerRequestHeaders;
  vi.spyOn(actionAuthorization, 'resolveExternalActionServerRequestHeaders').mockImplementation(args => {
    const result = resolveHeaders(args);
    const authorization = args.context?.externalActionExecutionAuthorization;
    if (args.path === '/v1/machines/effect-machine' && authorization) {
      observations.push({ rootAction: authorization.binding.actionId,
        sourceMachine: authorization.binding.sessionActionSource?.machineId,
        boundMachine: authorization.binding.machineId,
        credentialAvailable: Boolean(readRequesterAccountActionContext(authorization)),
        reason: result.ok ? null : result.reason });
    }
    return result;
  });
  let effectMachineReads = 0;
  vi.mocked(axios.get).mockImplementation(async (...args) => {
    const path = new URL(String(args[0])).pathname;
    if (path === '/v1/machines/effect-machine') effectMachineReads++;
    if (path === AUTOMATION_ACTION_INDEX_HTTP_PATH_V1)
      return { status: 200, data: ActionAutomationIndexV1Schema.parse({ v: 1, rows: [] }) };
    if (path.startsWith('/v1/artifacts/')) {
      const artifact = artifacts.get(path.slice('/v1/artifacts/'.length));
      return artifact
        ? { status: 200, data: artifact }
        : { status: 404, data: { error: 'not_found' } };
    }
    const response = await homeRead(...args);
    // The Session still runs in the permission mode the Agent asked from.
    if (path !== `/v2/sessions/${h.sessionId}`) return response;
    return { ...response, data: { ...response.data, session: { ...response.data.session,
      metadata: JSON.stringify({ ...JSON.parse(response.data.session.metadata), permissionMode: 'default' }) } } };
  });
  const record = (path: string) => {
    if (path.startsWith('/v2/sessions/') || path.startsWith('/v1/sessions/'))
      sessionWrites.push(path);
  };
  vi.mocked(axios.post).mockImplementation(async (...args) => {
    const path = new URL(String(args[0])).pathname;
    const existing = path.startsWith('/v1/artifacts/')
      ? artifacts.get(path.slice('/v1/artifacts/'.length))
      : undefined;
    if (path === '/v1/artifacts' || existing) {
      const mutation = readCarrierMutation(args[1]);
      const version = Number(existing?.bodyVersion ?? 0) + 1;
      const next = {
        ...existing,
        ...mutation,
        ownerAccountId: 'requester',
        access: 'owner',
        publicAudience: 'none',
        encryptionMode: 'plain',
        headerVersion: version,
        bodyVersion: version,
        seq: version,
        createdAt: 1,
        updatedAt: version,
      };
      artifacts.set(String(next.id), next);
      return {
        status: 200,
        data: {
          id: next.id,
          success: true,
          headerVersion: version,
          bodyVersion: version,
        },
      };
    }
    if (path.endsWith('/execution-authorization/verify'))
      return { status: 200, data: { ok: true } };
    const minted = path.match(
      /^\/v1\/actions\/([^/]+)\/execution-authorization$/u,
    );
    if (!minted) {
      record(path);
      return await homeWrite(...args);
    }
    // Home mints the root for the signed request it receives; this boundary echoes it.
    const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(
      args[1],
    );
    const actionId = decodeURIComponent(minted[1]!);
    return {
      status: 200,
      data: ExternalActionExecutionAuthorizationV1Schema.parse({
        v: 1,
        token: `${actionId}-root`,
        binding: {
          accountId: 'requester',
          custodianAccountId: 'requester',
          serverIdentityId: homeId,
          authentication: { kind: 'terminal', tokenEpoch: 0 },
          accountEncryptionMode: 'plain',
          machineId: 'machine',
          installationId: h.f.installation.installationId,
          admittedMachineRole: 'manage',
          actionId,
          requestId: request.envelope.requestId,
          target: request.envelope.target,
          requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(
            request.envelope,
          ),
          sessionActionOrigin: request.sessionActionOrigin,
          sessionActionSource: request.sessionActionSource,
        },
      }),
    };
  });
  await runWithServerHttpBaseUrl(homeUrl, () =>
    ensureCliActionPolicySettings(credentials, homeUrl),
  );
  const proposed = await h.dispatch({
    kind: 'action.execute',
    surface: 'agent',
    actionId: 'approval.request.create',
    requestId: h.operationBase().requestId,
    toolCallId: 'tool-propose-effect',
    input: {
      actionId,
      actionArgs: actionId === 'session.model.set'
        ? { sessionId: h.sessionId, modelId: 'default' }
        : { serverId: homeId, machineId: 'effect-machine' },
      summary: 'Review this Action',
      createdBy: { surface: 'session_agent', sessionId: h.sessionId },
    },
    witness: {
      turnId: 'turn',
      inputId: 'input',
      userMessageSeq: 1,
      userMessageSeqs: [1],
      workDepth: 0,
      agentStartCaller: {
        kind: 'session',
        sessionId: h.sessionId,
        starterDepth: 0,
        turnDepth: 0,
      },
      callerPermissionMode: 'default',
    },
  });
  expect(proposed, JSON.stringify(proposed)).toMatchObject({
    ok: true,
    result: { kind: 'action.execution', outcome: { ok: true } },
  });
  const artifactId = [...artifacts.keys()][0];
  if (!artifactId) throw new Error('No approval request was saved');
  const target = { kind: 'machine' as const, machineId: 'machine' };
  const decideInput = {
    artifactId,
    decision: 'approve',
    serverIdentityId: homeId,
  };
  const envelope = ExternalActionRequestEnvelopeSchema.parse({
    v: 1,
    requestId: 'decide-model',
    target,
    input: decideInput,
  });
  const decided = await executeExternalAction({
    ...owner,
    actionId: 'approval.request.decide',
    envelope,
    executionAuthorization: ExternalActionExecutionAuthorizationV1Schema.parse({
      v: 1,
      token: 'decide-root',
      binding: {
        accountId: 'requester',
        custodianAccountId: 'requester',
        serverIdentityId: homeId,
        authentication: { kind: 'account', tokenEpoch: 0 },
        accountEncryptionMode: 'plain',
        machineId: 'machine',
        installationId: h.f.installation.installationId,
        admittedMachineRole: 'manage',
        actionId: 'approval.request.decide',
        requestId: envelope.requestId,
        target,
        approvalDecisionAdmission:
          projectExternalActionApprovalDecisionAdmissionV1(decideInput),
        requestEnvelopeDigest:
          computeExternalActionRequestEnvelopeDigestV1(envelope),
      },
    }),
    principal: {
      accountId: 'requester',
      authority: 'present_user',
      authentication: { kind: 'account', tokenEpoch: 0 },
    },
    currentMachineId: 'machine',
    currentAccountId: 'requester',
    currentInstallationId: h.f.installation.installationId,
    verifyExecutionAuthorization: async () => true,
    signal: h.signal,
  });
  expect(decided, JSON.stringify(decided)).toMatchObject({
    kind: 'response',
    response: {
      execution: {
        ok: true,
        result: {
          status: 'failed',
          execution: {
            ok: false,
            errorCode: 'action_failed',
            error: failureMessage,
            requestId: expect.any(String),
            effectAttempted: false,
            failureCause: { phase: 'execution_authorization', errorCode: 'approval_replay_mismatch' },
          },
        },
      },
    },
  });
  expect(sessionWrites).toEqual([]);
  expect(effectMachineReads).toBe(0);
  expect(observations).toEqual(actionId === 'session.model.set' ? [] : [{
    rootAction: 'approval.request.create',
    sourceMachine: 'machine',
    boundMachine: 'machine',
    credentialAvailable: true,
    reason: 'approval_replay_mismatch',
  }]);
});
