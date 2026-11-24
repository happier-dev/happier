import axios from 'axios';
import { expect, it, onTestFailed, onTestFinished, vi } from 'vitest';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import {
  ExternalActionExecutionAuthorizationRequestV1Schema,
  ExternalActionExecutionAuthorizationV1Schema,
} from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { ApprovalRequestV2Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { ActionAutomationIndexV1Schema, AUTOMATION_ACTION_INDEX_HTTP_PATH_V1 } from '@happier-dev/protocol/automations/automationActionTriggerV1';
import { emptyPromptLibraryRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
import { PromptLibraryCatalogKeyV1Schema } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import type { SocketRpcRequestPayload } from '@happier-dev/protocol/rpc/socket';
import { applyPermissionModeIntentSessionMetadata } from '@happier-dev/agents/session/state/metadataWriters';
import { readCarrierMutation } from '@/api/artifacts/accountArtifactStore.testkit';
import { artifactListResponse } from '@/testkit/http/artifactHome';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { configuration } from '@/configuration';
import { createAgentRuntimeDaemonServiceAuthorityPath, publishAgentRuntimeDaemonServiceAuthority } from '@/daemon/agentRuntime/sessionBridgeAuthorization';
import type { startDaemonControlServer } from '@/daemon/controlServer';
import { createInstalledProjectAgentDaemonFixture } from '@/daemon/testkit/installedProjectAgentDaemonFixture';
import { createReceivingControllerDaemon } from '@/daemon/testkit/receivingControllerDaemon.testkit';
import { readBundledPluginAvailabilityHttpFixture } from '@/plugins/testkit/bundledPluginAvailabilityHttpFixture';
import { resetServerFeaturesClientForTests } from '@/features/serverFeaturesClient';
import { createCliApprovalsArtifactStore } from '@/session/actions/approvals/artifactStore';
import { ensureCliActionPolicySettings } from '@/session/actions/ensureCliActionPolicySettings';

const boundary = vi.hoisted(() => ({
  control: null as Parameters<typeof startDaemonControlServer>[0] | null,
  /** Home's Machine RPC relay toward the owner's controller; null leaves sockets real. */
  relay: null as ((packet: unknown) => Promise<unknown>) | null,
}));
// The private OS listener and Home HTTP are the boundaries. Agent dispatch, the
// installed Session Account executor, its daemon executor and approval signer stay real.
vi.mock('@/daemon/controlServer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/daemon/controlServer')>()),
  startDaemonControlServer: async (
    input: Parameters<typeof startDaemonControlServer>[0],
  ) => {
    // The member's daemon starts first; a receiving controller daemon must not replace its listener.
    boundary.control ??= input;
    return { port: 43129, stop: async () => {} };
  },
}));

// Home's Socket.IO endpoint is the boundary between the member's source daemon
// and the owner's controller daemon. While a case installs a relay, a user-scoped
// socket's CALL is handed to it; the client's RPC framing above stays real.
vi.mock('socket.io-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('socket.io-client')>();
  const { SOCKET_RPC_EVENTS } = await import('@happier-dev/protocol/rpc/socket');
  const { createSocketIoManagerStub } = await import('@/testkit/backends/apiSessionSocketHarness');
  const relaySocket = (relay: (packet: unknown) => Promise<unknown>) => {
    const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
    const socket = {
      io: createSocketIoManagerStub(),
      connected: false,
      connect: () => { socket.connected = true; for (const fn of listeners.get('connect') ?? []) fn(); return socket; },
      on: (event: string, fn: (...args: unknown[]) => void) => {
        const current = listeners.get(event) ?? new Set(); current.add(fn); listeners.set(event, current); return socket; },
      once: (event: string, fn: (...args: unknown[]) => void) => socket.on(event, fn),
      off: (event: string, fn?: (...args: unknown[]) => void) => {
        if (fn) listeners.get(event)?.delete(fn); else listeners.delete(event); return socket; },
      removeAllListeners: () => { listeners.clear(); return socket; },
      disconnect: () => { socket.connected = false; return socket; },
      close: () => socket.disconnect(),
      emit: (event: string, packet: unknown, ack?: (value: unknown) => void) => {
        if (event !== SOCKET_RPC_EVENTS.CALL) return socket;
        void relay(packet).then(result => ack?.({ ok: true, result }),
          (error: unknown) => ack?.({ ok: false, error: String(error) }));
        return socket;
      },
      emitWithAck: (event: string, packet: unknown) => new Promise<unknown>(resolve => socket.emit(event, packet, resolve)),
    };
    return socket;
  };
  return { ...actual, io: (...args: Parameters<typeof actual.io>) => boundary.relay
    ? relaySocket(boundary.relay) as unknown as ReturnType<typeof actual.io> : actual.io(...args) };
});

// The calling Session's own runner is a separate process reached over the
// Session socket; it answers the applied Agent selection of the calling turn.
vi.mock('@/session/transport/rpc/sessionRpc', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/session/transport/rpc/sessionRpc')>();
  const { SESSION_RPC_METHODS } = await import('@happier-dev/protocol/rpc/methods');
  const { resolveBackendTargetFromSessionMetadata } = await import('@/session/backendTargets/resolveBackendTargetFromSessionMetadata');
  return { ...original, callSessionRpc: async (params: Parameters<typeof original.callSessionRpc>[0]) => {
    const method = params.method.slice(params.method.indexOf(':') + 1);
    if (method !== SESSION_RPC_METHODS.SESSION_AGENT_START_SELECTION_READ_V1) return await original.callSessionRpc(params);
    const raw = Reflect.get(params, 'rawSession') as { metadata?: unknown } | undefined;
    const metadata = typeof raw?.metadata === 'string' ? JSON.parse(raw.metadata) as Record<string, unknown> : null;
    const backendTarget = resolveBackendTargetFromSessionMetadata(metadata);
    const turnId = (params.request as { turnId: string }).turnId;
    return { sessionId: params.sessionId, turnId, selection: backendTarget
      ? { status: 'applied', backendTarget, modelId: null, connectedServices: null } : { status: 'unavailable' } };
  } };
});

const homeId = 'srv_member_acquire_agent_start';
const homeUrl = 'https://member-home.test';
const OWNER_MACHINE_ID = 'owner-machine';

function accountToken(sub: string) {
  return `e30.${Buffer.from(JSON.stringify({ sub, tokenEpoch: 0,
    provenance: { v: 1, kind: 'terminal', authority: 'account_automation' } })).toString('base64url')}.signature`;
}

/** The Account a Home request authenticates as, read from its bearer token. */
function readRequestAccount(config: unknown): string | null {
  const header = (config as { headers?: Record<string, unknown> } | undefined)?.headers?.Authorization;
  const token = typeof header === 'string' ? header.replace(/^Bearer /, '') : '';
  try { return (JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString()) as { sub?: string }).sub ?? null; }
  catch { return null; }
}

type AcquireCase = Readonly<{
  /** Where the Team preset's controller runs. */
  controller: 'member machine' | 'owner machine';
  /** Whether the acquire input names the controller or leaves it to the preset. */
  namesController: boolean;
  /** An Agent start stamps the root; without it the acquire is an ordinary unstamped Session Action. */
  agentStart?: false;
  /** The member's own Action policy for an Agent's acquire. */
  memberPolicy: 'ask' | 'allow';
}>;

// A Session agent's managed acquire with agentStart on the member's installed
// daemon. With the owner's controller on another Machine, the member's source
// daemon reaches the owner's real controller daemon through Home's Machine RPC relay.
async function runMemberAcquire(acquire: AcquireCase) {
  onTestFinished(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    boundary.control = null;
    boundary.relay = null;
    resetServerFeaturesClientForTests();
  });
  const credentials = {
    token: accountToken('requester'),
    encryption: null,
    credentialProvenance: 'stored_session' as const,
  };
  const ownerCredentials = { token: accountToken('owner'), encryption: null };
  const policyFor = (policy: 'ask' | 'allow') => normalizeActionsSettingsV1(policy === 'ask'
    ? { v: 1, actions: { 'machines.managed.acquire': { approvalRequiredSurfaces: ['agent'] } } }
    : { v: 1, actions: {}, approvalWaivedSurfaces: { 'machines.managed.acquire': ['agent'] } });
  // The owner waives Agent acquires on its own Account, so an Ask at its
  // controller can only come from the member's policy.
  const ownerSettings = { actionsSettingsV1: policyFor('allow') };
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
      accountSettings: { actionsSettingsV1: policyFor(acquire.memberPolicy) },
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
  // A live Session reaches the private dispatcher through its runner's published
  // authority. The daemon's tracked record of it is what Session-caller currentness reads.
  const authority = await publishAgentRuntimeDaemonServiceAuthority({ happyHomeDir: h.f.directory,
    publicReleaseRing: configuration.publicReleaseRing,
    path: await createAgentRuntimeDaemonServiceAuthorityPath({ happyHomeDir: h.f.directory,
      publicReleaseRing: configuration.publicReleaseRing }),
    sessionId: h.sessionId, runner: h.runner, retainedAgent: h.retainedAgent, httpPort: 43129 });
  Object.assign(h.tracked, { agentRuntimeDaemonServiceAuthorityFilePath: authority.path,
    agentRuntimeDaemonServiceCapabilityHash: authority.capabilityDigest });
  // One process holds one Installation identity, so the owner's controller row names it too.
  const controller = acquire.controller === 'owner machine'
    ? { machineId: OWNER_MACHINE_ID, installationId: h.f.installation.installationId }
    : { machineId: 'machine', installationId: h.f.installation.installationId };
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
  const paths: string[] = [];
  /** Each Home request with the Account it authenticated as. */
  const homeRequests: string[] = [];
  const mints: ReturnType<
    typeof ExternalActionExecutionAuthorizationRequestV1Schema.parse
  >[] = [];
  /** Approval Artifacts by id, with the Account whose Home stored them. */
  const artifacts = new Map<string, Record<string, unknown>>();
  onTestFailed(() => console.error('Member acquire boundary outcomes', JSON.stringify({ homeRequests,
    origins: mints.map(mint => mint.sessionActionOrigin), artifacts: [...artifacts.keys()] })));
  vi.mocked(axios.get).mockImplementation(async (...args) => {
    const path = new URL(String(args[0])).pathname;
    const account = readRequestAccount(args[1]);
    paths.push(`GET ${path}`);
    homeRequests.push(`${account} GET ${path}`);
    // No Role or prompt Artifacts exist; the Asks are the only Artifacts, each in its Account.
    if (path === '/v1/artifacts')
      return { status: 200, data: artifactListResponse(String(args[0]),
        [...artifacts.values()].filter(artifact => artifact.ownerAccountId === account)) };
    // Neither Account has Action automations; Home answers its empty index.
    if (path === AUTOMATION_ACTION_INDEX_HTTP_PATH_V1)
      return { status: 200, data: ActionAutomationIndexV1Schema.parse({ v: 1, rows: [] }) };
    // The owner's controller daemon authenticates as the owner.
    if (path === '/v1/account/profile' && account === 'owner')
      return { status: 200, data: { id: 'owner' } };
    if (path === '/v2/account/settings' && account === 'owner')
      return { status: 200, data: { content: { t: 'plain', v: ownerSettings }, version: 0 } };
    // The live calling Session records the permission mode its turn runs under,
    // through the same metadata writer its runner uses.
    if (path === `/v2/sessions/${h.sessionId}`) {
      const read = await homeRead(...args);
      const session = read.data.session;
      return { ...read, data: { ...read.data, session: { ...session, metadata: JSON.stringify(
        applyPermissionModeIntentSessionMetadata(JSON.parse(session.metadata), { permissionMode: 'default', updatedAt: 1 })) } } };
    }
    // The owner's controller Machine, which the member reaches through its Team grant.
    if (path === `/v1/machines/${OWNER_MACHINE_ID}`) {
      const read = await homeRead(String(args[0]).replace(path, '/v1/machines/machine'), ...args.slice(1));
      // Home publishes the controller Installation's key; the source seals the requester's context to it.
      return { ...read, data: { machine: { ...read.data.machine, id: OWNER_MACHINE_ID,
        installationPublicKey: Buffer.from(h.f.installation.publicKey, 'base64url').toString('base64') } } };
    }
    if (path.startsWith('/v1/artifacts/')) {
      const artifact = artifacts.get(path.slice('/v1/artifacts/'.length));
      return artifact && artifact.ownerAccountId === account
        ? { status: 200, data: artifact }
        : { status: 404, data: { error: 'not_found' } };
    }
    return await homeRead(...args);
  });
  vi.mocked(axios.post).mockImplementation(async (...args) => {
    const path = new URL(String(args[0])).pathname;
    const account = readRequestAccount(args[2]);
    paths.push(`POST ${path}`);
    homeRequests.push(`${account} POST ${path}`);
    // The Agent target's plugin availability is a Home read.
    const availability = readBundledPluginAvailabilityHttpFixture(path, args[1]);
    if (availability !== undefined) return { status: 200, data: availability };
    const artifactId = path.startsWith('/v1/artifacts/') ? path.slice('/v1/artifacts/'.length) : null;
    if (path === '/v1/artifacts' || (artifactId && artifacts.has(artifactId))) {
      const mutation = readCarrierMutation(args[1]);
      const previous = artifactId ? artifacts.get(artifactId) : undefined;
      const version = Number(previous?.bodyVersion ?? 0) + 1;
      const artifact: Record<string, unknown> = {
        ...previous,
        ...mutation,
        ownerAccountId: previous?.ownerAccountId ?? account,
        access: 'owner',
        publicAudience: 'none',
        encryptionMode: 'plain',
        headerVersion: version,
        bodyVersion: version,
        seq: version,
        createdAt: 1,
        updatedAt: version,
      };
      artifacts.set(String(artifact.id), artifact);
      return {
        status: 200,
        data: {
          id: artifact.id,
          success: true,
          headerVersion: version,
          bodyVersion: version,
        },
      };
    }
    // The receiving controller's Home Machine admission check.
    if (path === `/v1/machines/${OWNER_MACHINE_ID}/admission/verify`)
      return { status: 200, data: { v: 1, ok: true } };
    // The Team preset names its controller Machine.
    if (path === '/v1/machines/presets/get')
      return { status: 200, data: { kind: 'found', preset: { id: 'team-preset', homeId, revision: 1,
        owner: { kind: 'account', accountId: 'requester' }, contentEncryptionMode: 'plain', recipients: [],
        content: { t: 'plain', v: { v: 1, name: 'Guest', launch: { provider: { pluginId: 'acme.compute', localId: 'vm' },
          schemaVersion: 1, name: 'guest', choices: {} } } },
        controller } } };
    if (path.endsWith('/execution-authorization/verify'))
      return { status: 200, data: { ok: true } };
    if (path !== '/v1/actions/machines.managed.acquire/execution-authorization')
      return await homeWrite(...args);
    // Home signs the origin the source host sends; this boundary echoes it into the root.
    const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(
      args[1],
    );
    mints.push(request);
    return {
      status: 200,
      data: ExternalActionExecutionAuthorizationV1Schema.parse({
        v: 1,
        token: 'member-acquire-root',
        binding: {
          accountId: 'requester',
          custodianAccountId: controller.machineId === 'machine' ? 'requester' : 'owner',
          serverIdentityId: homeId,
          authentication: { kind: 'terminal', tokenEpoch: 0 },
          accountEncryptionMode: 'plain',
          machineId: controller.machineId,
          installationId: controller.installationId,
          admittedMachineRole: 'manage',
          actionId: 'machines.managed.acquire',
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
  // The Home rows are the storage boundary. Seed the current empty library so
  // Role admission does not require unrelated legacy history migration.
  for (const key of PromptLibraryCatalogKeyV1Schema.options) h.f.mutatePromptLibraryRow(key, {
    expectedRevision: 'absent', sourceSettingsVersion: 0, content: { t: 'plain', v: emptyPromptLibraryRecordV1(key) },
  });
  await runWithServerHttpBaseUrl(homeUrl, () =>
    ensureCliActionPolicySettings(credentials, homeUrl),
  );
  // The owner's controller daemon runs on its own Machine and answers Home's relay.
  const relayed: SocketRpcRequestPayload[] = [];
  const delivered: unknown[] = [];
  /** What Home had seen when each CALL reached the controller. */
  const atDelivery: { homeRequests: number; artifacts: number }[] = [];
  if (acquire.controller === 'owner machine') {
    const receiver = await createReceivingControllerDaemon({ machineId: OWNER_MACHINE_ID, custodianAccountId: 'owner',
      credentials: ownerCredentials, serverId: 'session-home', serverBaseUrl: 'https://session-home.test',
      homeServerIdentityId: homeId, installationId: controller.installationId, happyHomeDir: h.f.directory,
      pluginRuntimeController: h.plugin.controller,
      resolveServerFeaturesSnapshot: () => ({ status: 'ready',
        features: FeaturesResponseSchema.parse({ features: {}, capabilities: {} }) }) });
    boundary.relay = async packet => {
      const call = packet as SocketRpcRequestPayload;
      relayed.push(call);
      atDelivery.push({ homeRequests: homeRequests.length, artifacts: artifacts.size });
      const result = await receiver.deliver(call, { actorAccountId: 'requester', role: 'manage' });
      delivered.push(result);
      return result;
    };
  }
  const outcome = await h.dispatch({
    kind: 'action.execute',
    surface: 'agent',
    actionId: 'machines.managed.acquire',
    requestId: h.operationBase().requestId,
    toolCallId: 'tool-acquire',
    input: {
      selection: { kind: 'preset', homeId, id: 'team-preset', revision: 1 },
      // The preset's controller places the acquire on a Machine, so it needs a Machine root.
      ...(acquire.namesController ? { controller } : {}),
      ...(acquire.agentStart === false ? {} : { agentStart: {
        directory: { kind: 'managed' },
        agentTarget: {
          kind: 'agent',
          identity: { pluginId: 'acme.project-launch', localId: 'agent' },
        },
      } }),
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
  const approvals = (accountId: string) => [...artifacts.values()].filter(artifact => artifact.ownerAccountId === accountId);
  const readApproval = async (artifactId: unknown) => ApprovalRequestV2Schema.parse(await createCliApprovalsArtifactStore({
    credentials, serverHttpBaseUrl: homeUrl }).approvalsGet({ artifactId: String(artifactId) }));
  /** Home requests the controller's handling of the first delivered CALL caused. */
  const controllerRequests = () => homeRequests.slice(atDelivery[0]?.homeRequests ?? homeRequests.length);
  return { h, credentials, controller, outcome, paths, homeRequests, mints, relayed, delivered, atDelivery,
    approvals, readApproval, controllerRequests };
}

// Ruling O-MACH 2026-11-24 13:42Z (S-IDENTITY step 5a) moves the requester's
// approval decision to the source for roots bound to another Machine; it leaves
// this same-Machine path as it is. The producer resolves the controller from the
// preset, so an acquire that names none is placed on that controller exactly as one that names it.
it.each([true, false])("today: a Session agent's acquire whose preset controller is its own Machine is admitted once and asked on that Machine, with the stamped root in its Ask (names controller=%s)", async namesController => {
  const run = await runMemberAcquire({ controller: 'member machine', namesController, memberPolicy: 'ask' });
  const { outcome, paths, mints, credentials } = run;
  expect(outcome, JSON.stringify({ outcome, paths, origins: mints.map(mint => mint.sessionActionOrigin) })).toMatchObject({
    ok: true,
    result: {
      kind: 'action.execution',
      outcome: { ok: true, result: { kind: 'approval_request_created' } },
    },
  });
  // One source admission, before Home signs: the origin Home receives carries its stamp.
  expect(mints).toHaveLength(1);
  expect(mints[0]?.envelope).toMatchObject({ target: { kind: 'machine', machineId: 'machine' },
    input: { controller: run.controller } });
  const stamp = mints[0]?.sessionActionOrigin?.agentStartAdmission;
  expect(stamp).toMatchObject({ workDepth: 1 });
  // The Ask retains that signed root, so its replay consumes the same admission.
  const [artifact] = run.approvals('requester');
  const store = createCliApprovalsArtifactStore({
    credentials,
    serverHttpBaseUrl: homeUrl,
  });
  const request = ApprovalRequestV2Schema.parse(
    await store.approvalsGet({ artifactId: String(artifact?.id) }),
  );
  expect(request).toMatchObject({
    status: 'open',
    actionId: 'machines.managed.acquire',
    executionOriginV1: {
      surface: 'agent',
      caller: { kind: 'session' },
      externalActionExecutionAuthorization: {
        token: 'member-acquire-root',
        binding: { sessionActionOrigin: { agentStartAdmission: stamp } },
      },
    },
  });
  expect(
    paths.some((path) =>
      path.startsWith('POST /v1/machines/managed/controller/'),
    ),
  ).toBe(false);
  // The producer reads the preset once per acquire to resolve its controller.
  expect(paths.filter(path => path === 'POST /v1/machines/presets/get')).toHaveLength(1);
  expect(run.relayed).toEqual([]);
}, 120_000);

/** The delivered CALL carries the source's one signed root unchanged. */
function expectDeliveredRoot(run: Awaited<ReturnType<typeof runMemberAcquire>>) {
  expect(run.mints).toHaveLength(1);
  expect(run.relayed).toHaveLength(1);
  expect(run.relayed[0]).toMatchObject({ method: `${OWNER_MACHINE_ID}:machines.managed.acquire`,
    externalActionExecution: { authorization: { token: 'member-acquire-root', binding: {
      accountId: 'requester', custodianAccountId: 'owner', machineId: OWNER_MACHINE_ID,
      requestId: run.mints[0]?.envelope.requestId,
      sessionActionOrigin: run.mints[0]?.sessionActionOrigin,
      sessionActionSource: { machineId: 'machine' } } } } });
  // No Ask existed anywhere when the root left the member's daemon.
  expect(run.atDelivery).toEqual([expect.objectContaining({ artifacts: 0 })]);
}

// Ruling O-MACH 2026-11-24 13:42Z (S-IDENTITY step 5a) flips this: the member's
// Ask-first policy is decided at the source, which will ask before delivering,
// and the owner's controller will stop creating an Ask from the member's policy.
it("today: under the member's Ask-first policy the source delivers the stamped root unasked and the owner's controller creates the Ask from the member's policy in the member's Account", async () => {
  const run = await runMemberAcquire({ controller: 'owner machine', namesController: true, memberPolicy: 'ask' });
  expectDeliveredRoot(run);
  const stamp = run.mints[0]?.sessionActionOrigin?.agentStartAdmission;
  expect(stamp).toMatchObject({ workDepth: 1 });
  // The controller answers with an Ask; the member's Session receives that answer.
  const [ask] = run.approvals('requester');
  expect(run.delivered).toEqual([{ kind: 'approval_request_created', actionId: 'machines.managed.acquire', artifactId: ask?.id }]);
  expect(run.outcome).toMatchObject({ ok: true, result: { kind: 'action.execution',
    outcome: { ok: true, result: { kind: 'approval_request_created', artifactId: ask?.id } } } });
  // The controller read the member's policy, never the owner's, and stored the
  // Ask under the member's Account: the member sees it, the owner does not.
  const controllerRequests = run.controllerRequests();
  expect(controllerRequests).toContain('requester GET /v2/account/settings');
  expect(controllerRequests).toContain('requester POST /v1/artifacts');
  expect(run.homeRequests).not.toContain('owner GET /v2/account/settings');
  expect(run.approvals('owner')).toEqual([]);
  expect(await run.readApproval(ask?.id)).toMatchObject({ status: 'open', actionId: 'machines.managed.acquire',
    // The Ask's replay host is the owner's controller Machine.
    executionOriginV1: { surface: 'agent', accountId: 'requester', machineId: OWNER_MACHINE_ID, caller: { kind: 'session' },
      externalActionExecutionAuthorization: { token: 'member-acquire-root',
        binding: { machineId: OWNER_MACHINE_ID, sessionActionOrigin: { agentStartAdmission: stamp } } } } });
  // Nothing reached the controller's managed admission while the Ask is open.
  expect(run.paths.some(path => path.startsWith('POST /v1/machines/managed/controller/'))).toBe(false);
}, 120_000);

// Ruling O-MACH 2026-11-24 13:42Z (S-IDENTITY step 5a) keeps the outcome and
// moves where the "allow" is decided: the source, not the owner's controller.
it("today: under the member's allow policy the source delivers the stamped root and the owner's controller reads the member's policy, asks no one and accepts the acquire operation", async () => {
  const run = await runMemberAcquire({ controller: 'owner machine', namesController: true, memberPolicy: 'allow' });
  expectDeliveredRoot(run);
  expect(run.delivered).toEqual([{ status: 'accepted', operationId: expect.any(String), machineId: OWNER_MACHINE_ID }]);
  expect(run.outcome).toMatchObject({ ok: true, result: { kind: 'action.execution',
    outcome: { ok: true, result: { status: 'accepted', machineId: OWNER_MACHINE_ID } } } });
  expect(run.controllerRequests()).toContain('requester GET /v2/account/settings');
  expect(run.homeRequests).not.toContain('owner GET /v2/account/settings');
  expect(run.approvals('requester')).toEqual([]);
  expect(run.approvals('owner')).toEqual([]);
}, 120_000);

// Ruling O-MACH 2026-11-24 13:42Z (S-IDENTITY step 5a) applies to every
// Session-origin root bound to another Machine, stamped or not.
it("today: an unstamped Session acquire on the owner's controller under the member's Ask-first policy is delivered unasked and asked by the controller in the member's Account", async () => {
  const run = await runMemberAcquire({ controller: 'owner machine', namesController: true, memberPolicy: 'ask', agentStart: false });
  expectDeliveredRoot(run);
  expect(run.mints[0]?.sessionActionOrigin).not.toHaveProperty('agentStartAdmission');
  const [ask] = run.approvals('requester');
  expect(run.delivered).toEqual([{ kind: 'approval_request_created', actionId: 'machines.managed.acquire', artifactId: ask?.id }]);
  expect(run.controllerRequests()).toEqual(expect.arrayContaining(['requester GET /v2/account/settings', 'requester POST /v1/artifacts']));
  expect(run.homeRequests).not.toContain('owner GET /v2/account/settings');
  expect(run.approvals('owner')).toEqual([]);
  expect(await run.readApproval(ask?.id)).toMatchObject({ status: 'open', actionId: 'machines.managed.acquire',
    executionOriginV1: { accountId: 'requester', machineId: OWNER_MACHINE_ID } });
}, 120_000);
