import axios from 'axios';
import { expect, it, onTestFinished, vi } from 'vitest';
import type { Socket } from 'socket.io';
import {
  EXTERNAL_ACTION_HTTP_PATH_PREFIX_V1,
  ExternalActionExecutionAuthorizationRequestV1Schema,
  ExternalActionExecutionAuthorizationV1Schema,
  bindExternalActionExecutionAuthorizationHttpPathV1,
  projectExternalActionDeploymentMetadataEnvelopeEnvironmentIdV1,
  projectExternalActionDeploymentNativeEnvelopeAdmissionV1,
  projectExternalActionDeploymentReadEnvelopeAdmissionV1,
} from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1, isExternalActionAuthorizationBoundToEnvelope } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import {
  normalizeActionsSettingsV1,
  setActionApprovalOverride,
} from '@happier-dev/protocol/actions/actionSettings';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { AUTHORITY_CEILING_HEADER_V1 } from '@happier-dev/protocol/actions/invocationAuthority';
import {
  SOCKET_RPC_EVENTS,
  type SocketRpcRequestPayload,
} from '@happier-dev/protocol/socketRpc';
import { isDeploymentChildRootActionIdV1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import { createDeploymentEnvironmentDetailV1 } from '@happier-dev/deployment-protocol/testing/v1';
import type { startDaemonControlServer } from '@/daemon/controlServer';
import { createInstalledProjectAgentDaemonFixture } from '@/daemon/testkit/installedProjectAgentDaemonFixture';
import { writeDaemonSettingsFixture } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { reloadConfiguration } from '@/configuration';
import { logger } from '@/ui/logger';

const boundary = vi.hoisted(() => ({
  control: null as Parameters<typeof startDaemonControlServer>[0] | null,
}));
// Only the private HTTP listener is substituted. The installed Session source,
// requester runtime, Session issuer, real factory and delivery owners stay real;
// Home (mint, Environment read, admitted-root relay) is the axios boundary.
vi.mock('@/daemon/controlServer', () => ({
  startDaemonControlServer: async (
    input: Parameters<typeof startDaemonControlServer>[0],
  ) => {
    boundary.control = input;
    return { port: 43131, stop: async () => {} };
  },
}));

const domainAddActionId = 'deployments.domains.add';
const controllerMachineId = 'remote-controller';

type Scenario = Readonly<{
  actionId?: 'deployments.domains.add' | 'deployments.rollback' | 'deployments.health.current'
    | 'machines.capabilities.detect' | 'machines.terminal.list';
  relayedResult?: unknown;
  relayExecution?: ActionExecuteResult;
  input?: Readonly<Record<string, unknown>>;
  approvalRequired?: boolean;
  mintRefusal?: Readonly<{ status: number; data: unknown }>;
}>;

/** Home's mint binds these envelope projections (apps/server/sources/app/auth/auth.ts). */
function rootEnvironmentBinding(actionId: string, machineId: string,
  envelope: ReturnType<typeof ExternalActionExecutionAuthorizationRequestV1Schema.parse>['envelope']) {
  const environmentId = projectExternalActionDeploymentMetadataEnvelopeEnvironmentIdV1({ actionId, envelope });
  const native = projectExternalActionDeploymentNativeEnvelopeAdmissionV1({ actionId, envelope });
  const read = projectExternalActionDeploymentReadEnvelopeAdmissionV1({ actionId, machineId, envelope });
  return {
    ...(isDeploymentChildRootActionIdV1(actionId) ? { deploymentChildRoot: true as const } : {}),
    ...(native?.environmentId ?? environmentId ? { environmentId: native?.environmentId ?? environmentId } : {}),
    ...(native && 'kind' in native ? { deploymentNativeAdmission: native }
      : native ? { deploymentCandidatePublication: { environmentId: native.environmentId,
        source: { id: 'source', revision: 1 }, contentArtifactId: 'candidate-content' } } : {}),
    ...(read ? { deploymentReadAdmission: read } : {}),
  };
}

async function runSessionDomainAdd(scenario: Scenario = {}) {
  const actionId = scenario.actionId ?? domainAddActionId;
  onTestFinished(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    boundary.control = null;
  });
  const refusalLog = vi.spyOn(logger, 'warnLocalFile');
  const home = `srv_${'b'.repeat(32)}`;
  const credentials = {
    token: `e30.${Buffer.from(
      JSON.stringify({
        sub: 'requester',
        tokenEpoch: 0,
        provenance: { v: 1, kind: 'terminal', authority: 'account_automation' },
      }),
    ).toString('base64url')}.signature`,
    encryption: null,
  };
  const custodianCredentials = {
    token: `e30.${Buffer.from(
      JSON.stringify({
        sub: 'custodian',
        tokenEpoch: 0,
        provenance: { v: 1, kind: 'terminal', authority: 'account_automation' },
      }),
    ).toString('base64url')}.signature`,
    encryption: null,
  };
  const h = await createInstalledProjectAgentDaemonFixture(
    () => boundary.control,
    undefined,
    true,
    undefined,
    undefined,
    {
      credentials: custodianCredentials,
      accountActionCredentials: credentials,
      requesterCredentials: credentials,
      homeServerIdentityId: home,
      machineAccess: { custodianAccountId: 'custodian', role: 'use' },
      resolveCurrentMachineExecutionOriginContext: async () => ({
        serverIdentityId: home,
        machineId: 'machine',
      }),
      accountSettings: {
        actionsSettingsV1: setActionApprovalOverride({
          settings: normalizeActionsSettingsV1(),
          actionId,
          surface: 'agent',
          approvalRequired: scenario.approvalRequired === true,
        }),
      },
    },
  );
  const serverId = h.f.bootstrap.attribution.serverId;
  await writeDaemonSettingsFixture(h.f.directory, {
    activeServerId: serverId,
    servers: {
      [serverId]: {
        id: serverId,
        name: 'Session Home',
        serverUrl: 'https://session-home.test',
        webappUrl: 'https://session-home.test',
        createdAt: 0,
        updatedAt: 0,
        lastUsedAt: 0,
        homeConnectionDescriptorAuthority: 'exact',
        homeConnectionDescriptor: {
          v: 1,
          homeServerIdentityId: home,
          canonicalServerUrl: 'https://session-home.test',
          revision: 1,
          endpoints: [{ kind: 'https', url: 'https://session-home.test' }],
        },
      },
    },
    machineIdByServerId: { [serverId]: 'machine' },
    lastTokenSubByServerId: { [serverId]: 'requester' },
  });
  reloadConfiguration();
  const environment = createDeploymentEnvironmentDetailV1();
  environment.environment.id = 'environment';
  environment.environment.serverId = home;
  environment.environment.owner = { kind: 'account', accountId: 'requester' };
  environment.environment.controllerMachineId = controllerMachineId;
  const input = scenario.input ? { serverId: home, ...scenario.input } : {
    serverId: home,
    environmentId: 'environment',
    targetLinkId: 'runtime',
    requestKey: 'agent-domain',
    domainId: 'domain',
    expectedRevision: 3,
    expectedTargetLinkRevision: 2,
    contentArtifactId: 'domain-content',
    contentHeaderVersion: 1,
    contentBodyVersion: 1,
  };
  const homeRead = vi.mocked(axios.get).getMockImplementation();
  const homeWrite = vi.mocked(axios.post).getMockImplementation();
  if (!homeRead || !homeWrite)
    throw new Error('Missing canonical Home network fixture');
  const mintMachineIds: string[] = [];
  const relayed: Array<
    Readonly<{
      body: ReturnType<
        typeof ExternalActionExecutionAuthorizationRequestV1Schema.parse
      >;
      headers: Readonly<Record<string, string>>;
    }>
  > = [];
  let minted:
    | ReturnType<typeof ExternalActionExecutionAuthorizationV1Schema.parse>
    | undefined;
  vi.mocked(axios.get).mockImplementation(async (...args) => {
    // The requester's own Environment read is the placement fact; Home still admits.
    if (
      new URL(String(args[0])).pathname ===
      '/v1/deployments/environments/environment'
    )
      return {
        status: 200,
        data: {
          ok: true,
          environment: environment.environment,
          targetLinks: environment.targetLinks.map((item) => item.targetLink),
        },
      };
    return homeRead(...args);
  });
  vi.mocked(axios.post).mockImplementation(async (...args) => {
    const path = new URL(String(args[0])).pathname;
    if (path === bindExternalActionExecutionAuthorizationHttpPathV1(actionId)) {
      const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(
        args[1],
      );
      mintMachineIds.push(request.machineId);
      if (scenario.mintRefusal) return scenario.mintRefusal;
      if (!request.sessionActionOrigin || !request.sessionActionSource)
        throw new Error('Missing installed Session root proof');
      minted = ExternalActionExecutionAuthorizationV1Schema.parse({
        v: 1,
        token: 'session-domain-root',
        binding: {
          accountId: 'requester',
          authentication: { kind: 'terminal', tokenEpoch: 0 },
          serverIdentityId: home,
          machineId: request.machineId,
          custodianAccountId: 'requester',
          installationId: 'controller-installation',
          actionId,
          requestId: request.envelope.requestId,
          target: request.envelope.target,
          accountEncryptionMode: 'plain',
          requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(
            request.envelope,
          ),
          sessionActionOrigin: request.sessionActionOrigin,
          sessionActionSource: request.sessionActionSource,
          // Home binds the Environment facts its own projections derive from the envelope.
          ...rootEnvironmentBinding(actionId, request.machineId, request.envelope),
        },
      });
      if (!isExternalActionAuthorizationBoundToEnvelope(minted.binding, { actionId, machineId: request.machineId, envelope: request.envelope })) {
        throw new Error('Home fixture root is not bound to its envelope');
      }
      return { status: 200, data: minted };
    }
    if (path === `${EXTERNAL_ACTION_HTTP_PATH_PREFIX_V1}${actionId}`) {
      const body = ExternalActionExecutionAuthorizationRequestV1Schema.parse(
        args[1],
      );
      relayed.push({
        body,
        headers: (args[2]?.headers ?? {}) as Record<string, string>,
      });
      const requestId = body.envelope.requestId;
      const execution = scenario.relayExecution ?? (scenario.approvalRequired
        ? {
            ok: true,
            result: {
              kind: 'approval_request_created',
              actionId,
              artifactId: 'approval-on-controller',
            },
          }
        : { ok: true, result: scenario.relayedResult ?? { ok: true, domain: { id: 'domain' } } });
      return { status: 200, data: { v: 1, actionId, requestId, execution } };
    }
    return homeWrite(...args);
  });
  const published: SocketRpcRequestPayload[] = [];
  const observeSocket = (socket: Socket) =>
    socket.on(
      SOCKET_RPC_EVENTS.CALL,
      (
        packet: SocketRpcRequestPayload,
        acknowledge: (result: unknown) => void,
      ) => {
        published.push(packet);
        acknowledge({
          ok: false,
          errorCode: 'rpc_method_not_found',
          error: 'rpc_method_not_found',
        });
      },
    );
  for (const socket of h.f.channel.server.sockets.sockets.values())
    observeSocket(socket);
  h.f.channel.server.on('connection', observeSocket);
  const result = await h.dispatch({
    kind: 'action.execute',
    surface: 'agent',
    actionId,
    requestId: h.operationBase().requestId,
    input,
    witness: {
      turnId: 'domain-turn',
      inputId: 'domain-input',
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
  const outcome =
    result.ok && result.result.kind === 'action.execution'
      ? result.result.outcome
      : undefined;
  // Closed producer phase/reason identifiers only, never roots, operands or credentials.
  const phases = refusalLog.mock.calls.flatMap(([message, data]) => {
    if ((message !== '[Session Account Action] Refused' && message !== '[external-action-phase]')
      || !data || typeof data !== 'object') return [];
    const row = data as Record<string, unknown>;
    return [['reason', 'phase', 'refusalPhase', 'refusalBranch', 'refusalReason', 'errorCode']
      .flatMap(key => typeof row[key] === 'string' ? [`${key}=${row[key] as string}`] : []).join(',')];
  });
  const diagnostic = JSON.stringify({ errorCode: outcome && !outcome.ok ? outcome.errorCode : null,
    details: outcome && !outcome.ok && outcome.details && typeof outcome.details === 'object'
      ? Object.fromEntries(Object.entries(outcome.details).filter(([, value]) => typeof value === 'string')) : null,
    phases });
  return {
    h,
    diagnostic,
    outcome,
    mintMachineIds,
    relayed,
    published,
    minted: () => minted,
    credentials,
  };
}

it('delivers a Session-origin domain root to the Environment controller through the admitted-root relay', async () => {
  const run = await runSessionDomainAdd();
  expect(
    run.mintMachineIds,
    'Home mints the root for the recorded controller, not the Session host',
  ).toEqual([controllerMachineId]);
  expect(
    run.published.map((packet) => packet.method),
    'no exact Machine RPC to an unregistered method',
  ).toEqual([]);
  expect(run.relayed, run.diagnostic).toHaveLength(1);
  const delivered = run.relayed[0]!;
  const minted = run.minted();
  if (!minted) throw new Error('Missing minted root');
  expect(delivered.body.machineId).toBe(controllerMachineId);
  expect(delivered.body.executionAuthorization).toEqual({
    v: 1,
    token: minted.token,
    binding: minted.binding,
  });
  expect(
    computeExternalActionRequestEnvelopeDigestV1(delivered.body.envelope),
  ).toBe(minted.binding.requestEnvelopeDigest);
  expect(
    delivered.body.executionAuthorization?.binding.sessionActionOrigin?.caller,
  ).toMatchObject({ kind: 'session', sessionId: run.h.sessionId });
  expect(delivered.headers.Authorization).toBe(
    `Bearer ${run.credentials.token}`,
  );
  expect(delivered.headers[AUTHORITY_CEILING_HEADER_V1]).toBe(
    'account_automation',
  );
  expect(run.outcome).toMatchObject({
    ok: true,
    result: { ok: true, domain: { id: 'domain' } },
  });
}, 120_000);

it('returns the controller-decided approval to the agent unchanged', async () => {
  const run = await runSessionDomainAdd({ approvalRequired: true });
  expect(run.mintMachineIds).toEqual([controllerMachineId]);
  expect(run.relayed, run.diagnostic).toHaveLength(1);
  expect(
    run.relayed[0]!.body.executionAuthorization?.binding.sessionActionOrigin
      ?.caller.sessionId,
  ).toBe(run.h.sessionId);
  expect(run.outcome).toMatchObject({
    ok: true,
    result: {
      kind: 'approval_request_created',
      artifactId: 'approval-on-controller',
    },
  });
}, 120_000);

it('settles a Home refusal for the controller before any delivery, keeping its remedy', async () => {
  const remedy = `Run this from Machine ${controllerMachineId}`;
  const run = await runSessionDomainAdd({
    mintRefusal: {
      status: 403,
      data: {
        error: 'credential_scope_denied',
        details: { requiredFact: 'deployment.controller.placement', remedy },
      },
    },
  });
  expect(run.mintMachineIds).toEqual([controllerMachineId]);
  expect(run.relayed).toEqual([]);
  expect(run.published).toEqual([]);
  expect(run.outcome).toMatchObject({ ok: false });
}, 120_000);

it.each([
  ['deployments.rollback', { environmentId: 'environment', deploymentId: 'deployment-1', requestKey: 'agent-rollback' }],
  ['deployments.health.current', { environmentId: 'environment', targetLinkId: 'runtime', machineId: controllerMachineId }],
] as const)('delivers the Account-placed controller root %s from a Session on another Machine', async (actionId, input) => {
  const run = await runSessionDomainAdd({ actionId, input });
  expect(run.mintMachineIds).toEqual([controllerMachineId]);
  expect(run.published).toEqual([]);
  expect(run.relayed, run.diagnostic).toHaveLength(1);
  expect(run.relayed[0]!.body.machineId).toBe(controllerMachineId);
  expect(run.relayed[0]!.body.executionAuthorization?.binding.sessionActionOrigin?.caller.sessionId).toBe(run.h.sessionId);
  expect(run.outcome).toMatchObject({ ok: true });
}, 120_000);

// These Machine-placed Actions carry a raw daemon rpcMethod but no Action RPC
// registration (surfaces.rpc false), so the receiver has no handler that opens
// a targeted Action envelope. A cross-Machine Session root must take the
// admitted-root relay, never the raw method that would answer an empty request.
it.each([
  ['machines.capabilities.detect', { machineId: controllerMachineId }, { status: 'completed' }],
  ['machines.terminal.list', { machineId: controllerMachineId }, { ok: true, terminals: [] }],
] as const)('delivers the non-RPC Machine Action %s from a Session on another Machine through the admitted-root relay', async (actionId, input, relayedResult) => {
  const run = await runSessionDomainAdd({ actionId, input, relayedResult });
  expect(run.published.map((packet) => packet.method), 'no raw Machine RPC for an Action without an RPC registration').toEqual([]);
  expect(run.relayed, run.diagnostic).toHaveLength(1);
  expect(run.relayed[0]!.body.machineId).toBe(controllerMachineId);
  const delivered = run.relayed[0]!.body;
  expect(delivered.envelope).toMatchObject({ v: 1, input });
  expect(run.mintMachineIds).toEqual([controllerMachineId]);
  expect(computeExternalActionRequestEnvelopeDigestV1(delivered.envelope))
    .toBe(run.minted()?.binding.requestEnvelopeDigest);
  expect(run.outcome).toMatchObject({ ok: true, result: relayedResult });
}, 120_000);

it.each([
  { errorCode: 'target_unavailable', details: { reason: 'machine_offline', requiredFact: 'machine_online', remedy: 'reconnect_machine' } },
  { errorCode: 'target_not_local', details: { phase: 'target_installation' } },
])('returns the remote Machine Action refusal $errorCode', async ({ errorCode, details }) => {
  const relayExecution = { ok: false as const, errorCode, error: errorCode, details };
  const run = await runSessionDomainAdd({
    actionId: 'machines.capabilities.detect',
    input: { machineId: controllerMachineId },
    relayExecution,
  });
  expect(run.mintMachineIds).toEqual([controllerMachineId]);
  expect(run.published).toEqual([]);
  expect(run.relayed, run.diagnostic).toHaveLength(1);
  expect(run.outcome).toMatchObject(relayExecution);
}, 120_000);
