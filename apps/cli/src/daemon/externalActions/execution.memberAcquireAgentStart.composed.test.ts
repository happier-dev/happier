import axios from 'axios';
import { expect, it, onTestFailed, onTestFinished, vi } from 'vitest';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { ActionOperationAcceptedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import {
  ExternalActionExecutionAuthorizationRequestV1Schema,
  ExternalActionExecutionAuthorizationV1Schema,
  ExternalActionDaemonDispatchRequestSchema,
  ExternalActionRequestEnvelopeSchema,
  EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1,
  EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER,
  EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER,
  parseExternalActionDaemonDispatchResult,
  parseExternalActionDaemonDispatchResultV1,
  projectExternalActionApprovalDecisionAdmissionV1,
} from '@happier-dev/protocol/actions/externalActionApi';
import { ACTION_API_SERVER_ORIGIN } from '@happier-dev/protocol/rpc';
import { MANAGED_PRESET_ACQUIRE_ROUTING_PATH_V1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { ApprovalExecutionV2Schema, ApprovalRequestV2Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
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
import { readInstallationIdentityIfExistsSync } from '@/daemon/identity/store';
import { createDaemonManagedMachineActionAdapter } from '@/daemon/startup/managedMachineActionAdapter';
import { projectExternalActionRequesterHttpAuthorization } from '@/api/externalActionExecutionAuthorization';
import { readBundledPluginAvailabilityHttpFixture } from '@/plugins/testkit/bundledPluginAvailabilityHttpFixture';
import { resetServerFeaturesClientForTests } from '@/features/serverFeaturesClient';
import { createCliApprovalsArtifactStore } from '@/session/actions/approvals/artifactStore';
import { ensureCliActionPolicySettings } from '@/session/actions/ensureCliActionPolicySettings';
import { executeExternalAction } from './executeExternalAction';
import { createConnectedAccountPurposeBindingOwner } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { createConnectedAccountRequestAuthSubjectRegistry } from '@/daemon/connectedServices/requestAuth/ConnectedAccountRequestAuthSubjectRegistry';
import { createManagedProviderOperationAuthority } from '@/daemon/connectedServices/purposeBindings/managedProviderOperationAuthority';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { fixture as nativeFixture, pendingEnrollmentGuestRoleSource, roleResult } from '@/plugins/runtime/invocation/actions/managedCustody.testkit';
import { ManagedAcceptedV1Schema, ManagedControllerReportV1Schema, ManagedControllerSubmitInputV1Schema, ManagedGetOutputV1Schema, ManagedInstallationCapabilityRequestV1Schema,
  ManagedInstallationServerOriginV1Schema, managedMachineActionEndpointPathV1, readManagedInstallationPurposeV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { MANAGED_BOOTSTRAP_RETRY_ACTION_ID_V1 } from '@happier-dev/protocol/machines/managed/actionIdsV1';
import { ManagedMachineV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { ACTION_OPERATION_RPC_METHODS_V2, ActionOperationGetV1ResponseSchema } from '@happier-dev/protocol/actions/operations/v1';
import { projectManagedMachinePresetForRecipientV1, sealManagedMachinePresetContentV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetContentV1';
import { createCliPayloadFixture } from '../../../../../packages/cli-common/src/systemTasks/testkit/createCliPayloadFixture';

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
const sessionHomeUrl = 'https://session-home.test';
const controllerServerId = 'controller-session-home';
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
  /** The member no longer holds a grant on the owner's controller Machine. */
  controllerGrant?: 'revoked';
  /** A Team preset whose owner delegated acquisition: the member holds no grant on its controller Machine. */
  delegated?: true;
  /** Home's acquire routing refuses this member (for example, the delegation was withdrawn). */
  routingRefused?: true;
  guestEnrollment?: true;
  /** Exercise the requester daemon’s operation read and automatic pairing. */
  automaticSignIn?: true;
  guestPairingLifetimeMs?: number;
  /** The member's Session runs on a Machine another person holds custody of, as a Use guest. */
  sessionHost?: 'custodian machine';
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
  if (acquire.guestEnrollment) {
    const payload = await createCliPayloadFixture();
    vi.stubEnv('HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_ROOT', payload.payloadRoot);
    onTestFinished(async () => {
      vi.unstubAllEnvs();
      await payload.cleanup();
    });
  }
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
    acquire.delegated ? delegatedComputePlugin(acquire.guestEnrollment, acquire.guestPairingLifetimeMs).plugin : undefined,
    undefined,
    {
      // A Use guest's Session on another person's Machine runs on that custodian's
      // daemon, which holds its own sign-in beside the requester's custody.
      ...(acquire.sessionHost === 'custodian machine' ? {
        credentials: { token: accountToken('custodian'), encryption: null },
        externalActionAccountId: 'custodian',
        machineAccess: { custodianAccountId: 'custodian', role: 'use' as const },
      } : {
        ordinaryAccountSession: true,
        credentials,
        externalActionAccountId: 'requester',
        machineAccess: { custodianAccountId: 'requester', role: 'manage' as const },
      }),
      accountActionCredentials: credentials,
      requesterCredentials: credentials,
      homeServerIdentityId: homeId,
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
          ...(acquire.automaticSignIn && url.pathname === '/v1/features/authenticated' ? { homeConnectionDescriptor: {
            v: 1, homeServerIdentityId: homeId, canonicalServerUrl: sessionHomeUrl, revision: 1,
            endpoints: [{ kind: 'https', url: sessionHomeUrl }],
          } } : {}),
          capabilities: { serverIdentity: { serverIdentityId: homeId },
            // Home's guest CLI source, which the owner's controller reads before acquiring.
            ...(acquire.delegated ? { guestCli: { source: acquire.guestEnrollment ? 'home-payload' : 'public-release', line: '0.3', channel: 'stable' } } : {}) },
        }),
      );
    return await homeFetch(...args);
  });
  const paths: string[] = [];
  /** Roots the member's daemon handed to Home's admitted-root relay. */
  const homeRelayed: ReturnType<typeof ExternalActionExecutionAuthorizationRequestV1Schema.parse>[] = [];
  const homeRelayResults: unknown[] = [];
  /** The owner's controller steps on Home's managed row, and its native reports. */
  const controllerSteps: string[] = [];
  const controllerReports: unknown[] = [];
  const requesterOccurrences: unknown[] = [];
  /** Guest-installation answers Home forwarded to the owner's controller, with the Account that sent each. */
  const installationAnswers: unknown[] = [];
  /** Pairing approvals Home received, with the Account that sent each. */
  const pairingApprovals: string[] = [];
  /** Everything the owner's controller process received from the member's side. */
  const controllerReceived: unknown[] = [];
  const delegatedPresetContent = sealManagedMachinePresetContentV1({ presetId: 'team-preset', mode: 'plain', content: { v: 1, name: 'Guest',
    launch: { provider: { pluginId: 'acme.project-launch', localId: delegatedComputePlugin().provisionerId },
      schemaVersion: 1, name: 'guest', choices: {} } } });
  let managed: ReturnType<typeof ManagedMachineV1Schema.parse> | undefined;
  let retainedPresetContent: ReturnType<typeof sealManagedMachinePresetContentV1>['content'] | undefined;
  let receiverManager: Awaited<ReturnType<typeof createReceivingControllerDaemon>>['manager'] | undefined;
  let controllerMachine: Awaited<ReturnType<typeof createReceivingControllerDaemon>>['machine'] | undefined;
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
    // Without a grant, Home's exact Machine read answers as for any Machine the actor cannot see.
    if (path === `/v1/machines/${OWNER_MACHINE_ID}` && (acquire.controllerGrant === 'revoked' || acquire.delegated))
      throw Object.assign(new axios.AxiosError('Request failed with status code 404', 'ERR_BAD_REQUEST'),
        { response: { status: 404, data: { error: 'Machine not found' } } });
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
        owner: acquire.delegated ? { kind: 'team', teamId: 'team' } : { kind: 'account', accountId: 'requester' },
        ...(acquire.delegated ? { teamAcquireDelegated: true } : {}), contentEncryptionMode: 'plain', recipients: [],
        content: { t: 'plain', v: { v: 1, name: 'Guest', launch: { provider: acquire.delegated
          ? { pluginId: 'acme.project-launch', localId: delegatedComputePlugin().provisionerId } : { pluginId: 'acme.compute', localId: 'vm' },
          schemaVersion: 1, name: 'guest', choices: {} } } },
        controller } } };
    // Home's acquire routing admits the member for the preset's exact controller,
    // with the controller's public installation key and custodian (no Machine grant).
    if (path === MANAGED_PRESET_ACQUIRE_ROUTING_PATH_V1)
      return { status: 200, data: acquire.routingRefused ? { kind: 'refused', code: 'permission_denied' }
        : { kind: 'resolved', controller, controllerAccess: { custodian: { accountId: 'owner' },
          installationPublicKey: h.f.installation.publicKey.replace(/=+$/u, '') } } };
    // The requester's own Account read of the guest row it enrolls.
    if (acquire.automaticSignIn && managed && account === 'requester' && path === managedMachineActionEndpointPathV1('machines.managed.get')) {
      const presetContent = projectManagedMachinePresetForRecipientV1({ content: retainedPresetContent ?? delegatedPresetContent.content,
        recipients: delegatedPresetContent.recipients, recipientAccountId: account });
      return { status: 200, data: ManagedGetOutputV1Schema.parse({ machine: managed, presetContent }) };
    }
    // Home's pairing response: the approving Account's own sign-in seals the guest's credential.
    if (path === '/v1/auth/response') {
      pairingApprovals.push(String(account));
      return { status: 200, data: { success: true } };
    }
    // Home's managed-row routes the owner's controller reaches after it opens the relayed root.
    if (acquire.delegated && path.startsWith('/v1/machines/managed/controller/')) {
      const step = path.slice('/v1/machines/managed/controller/'.length);
      controllerSteps.push(`${account} ${step}`);
      managed ??= ManagedMachineV1Schema.parse({ id: 'delegated-guest', homeId, custodianAccountId: 'owner',
        ...(acquire.guestEnrollment ? { enrollmentAccountId: 'requester' } : {}),
        preset: { id: 'team-preset', revision: 1, contentEncryptionMode: 'plain' }, controller, allocation: 'unsubmitted',
        creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 0,
        retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false });
      if (step === 'admit') return { status: 200, data: { machine: managed, presetContent: delegatedPresetContent, replayed: false } };
      if (step === 'current') return { status: 200, data: { machine: managed } };
      if (step === 'enrollment-context') return { status: 200, data: { machine: managed } };
      if (step === 'context') return { status: 200, data: { machine: managed, requestId: mints.at(-1)?.envelope.requestId,
        presetContent: retainedPresetContent ? { ...delegatedPresetContent, content: retainedPresetContent } : delegatedPresetContent } };
      if (step === 'submit') {
        ManagedControllerSubmitInputV1Schema.parse(args[1]);
        managed = ManagedMachineV1Schema.parse({ ...managed, allocation: 'may-exist' });
        return { status: 200, data: { machine: managed, submitted: true } };
      }
      if (step === 'report') {
        if (typeof args[1] === 'object' && args[1] && 'signInOccurrence' in args[1]) {
          requesterOccurrences.push({ ...args[1].signInOccurrence as Record<string, unknown>,
            homeId: managed.homeId, managedId: managed.id, requesterAccountId: managed.enrollmentAccountId });
          return { status: 200, data: { observed: true } };
        }
        const report = ManagedControllerReportV1Schema.parse(args[1]);
        controllerReports.push(report);
        if (acquire.guestEnrollment) {
          if ('presetContent' in report) retainedPresetContent = report.presetContent;
          managed = ManagedMachineV1Schema.parse({ ...managed, allocation: 'bound' });
        }
        return { status: 200, data: { machine: managed } };
      }
    }
    // Home's admitted-root relay: the member's HTTP body arrives as JSON, and Home
    // forwards its closed dispatch frame to the owner's Machine socket with the
    // Action API server origin (externalActionDispatcher.ts), as Home delivers it.
    if (path === '/v1/actions/machines.managed.acquire') {
      const body = ExternalActionExecutionAuthorizationRequestV1Schema.parse(JSON.parse(JSON.stringify(args[1])));
      homeRelayed.push(body);
      const authorization = body.executionAuthorization;
      if (!receiverManager || !authorization) return { status: 503, data: { error: 'unavailable' } };
      const dispatch = ExternalActionDaemonDispatchRequestSchema.parse(JSON.parse(JSON.stringify({
        actionId: 'machines.managed.acquire', envelope: body.envelope, executionAuthorization: authorization,
        principal: { accountId: 'requester', authority: 'account_automation', authentication: { kind: 'terminal', tokenEpoch: 0 } },
        placement: { machineId: OWNER_MACHINE_ID, target: body.envelope.target } })));
      controllerReceived.push(dispatch);
      const result = await receiverManager.handleRequest({ method: `${OWNER_MACHINE_ID}:${EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1}`,
        params: dispatch, authorization: ACTION_API_SERVER_ORIGIN,
        // Home's public managed admission for the admitted member (its delegation fact stays server-side).
        machineAdmission: { actorAccountId: 'requester', custodianAccountId: 'owner', machineId: OWNER_MACHINE_ID,
          installationId: controller.installationId, role: 'manage', encryptionMode: 'plain' } }, undefined, 'authenticated_home_socket');
      homeRelayResults.push(result);
      const parsed = parseExternalActionDaemonDispatchResult(result);
      return parsed?.kind === 'response' ? { status: 200, data: JSON.parse(parsed.prepared.body) }
        : { status: 503, data: { error: 'unavailable' } };
    }
    if (path.endsWith('/execution-authorization/verify'))
      return { status: 200, data: { ok: true } };
    // Home's requester operation read: it mints a read root for the member's own operation on the
    // owner's controller and relays the sealed read to that Machine.
    if (acquire.automaticSignIn && path === '/v1/actions/action.operations.get/execution-authorization') {
      const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(JSON.parse(JSON.stringify(args[1])));
      return { status: 200, data: ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'member-operation-read',
        requesterOperationReadInstallationPublicKey: h.f.installation.publicKey.replace(/=+$/u, ''),
        binding: { accountId: 'requester', custodianAccountId: 'owner', serverIdentityId: homeId,
          authentication: { kind: 'terminal', tokenEpoch: 0 }, accountEncryptionMode: 'plain', machineId: request.machineId,
          installationId: controller.installationId, requesterOperationRead: true, actionId: 'action.operations.get',
          requestId: request.envelope.requestId, target: request.envelope.target,
          requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope) } }) };
    }
    if (acquire.automaticSignIn && path === '/v1/actions/action.operations.get') {
      const body = ExternalActionExecutionAuthorizationRequestV1Schema.parse(JSON.parse(JSON.stringify(args[1])));
      if (!receiverManager || !body.executionAuthorization) return { status: 503, data: { error: 'unavailable' } };
      const dispatch = ExternalActionDaemonDispatchRequestSchema.parse(JSON.parse(JSON.stringify({
        actionId: 'action.operations.get', envelope: body.envelope, executionAuthorization: body.executionAuthorization,
        principal: { accountId: 'requester', authority: 'account_automation', authentication: { kind: 'terminal', tokenEpoch: 0 } },
        placement: { machineId: OWNER_MACHINE_ID, target: body.envelope.target } })));
      controllerReceived.push(dispatch);
      const result = await receiverManager.handleRequest({ method: `${OWNER_MACHINE_ID}:${EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1}`,
        params: dispatch, authorization: ACTION_API_SERVER_ORIGIN,
        machineAdmission: { actorAccountId: 'requester', custodianAccountId: 'owner', machineId: OWNER_MACHINE_ID,
          installationId: controller.installationId, role: 'manage', encryptionMode: 'plain' } }, undefined, 'authenticated_home_socket');
      const parsed = parseExternalActionDaemonDispatchResult(result);
      return parsed?.kind === 'response' ? { status: 200, data: JSON.parse(parsed.prepared.body) }
        : { status: 503, data: { error: 'unavailable' } };
    }
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
          // Home binds the receiver the request names.
          custodianAccountId: request.machineId === 'machine' ? 'requester' : 'owner',
          serverIdentityId: homeId,
          authentication: { kind: 'terminal', tokenEpoch: 0 },
          accountEncryptionMode: 'plain',
          machineId: request.machineId,
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
          // Home signs the preset owner's reviewed delegation; callers cannot supply it.
          ...(acquire.delegated ? { managedAcquireDelegation: true } : {}),
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
    const receiver: Awaited<ReturnType<typeof createReceivingControllerDaemon>> = await createReceivingControllerDaemon({ machineId: OWNER_MACHINE_ID, custodianAccountId: 'owner',
      credentials: ownerCredentials, serverId: controllerServerId, serverBaseUrl: 'https://session-home.test',
      homeServerIdentityId: homeId, installationId: controller.installationId, happyHomeDir: h.f.directory,
      pluginRuntimeController: h.plugin.controller,
      resolveServerFeaturesSnapshot: () => ({ status: 'ready',
        features: FeaturesResponseSchema.parse({ features: {}, capabilities: {} }) }),
      // The owner's installed daemon holds its provider authority, as daemon startup supplies it.
      ...(acquire.delegated ? { managedProviderOperationAuthority: createControllerProviderAuthority() } : {}) });
    receiverManager = receiver.manager;
    controllerMachine = receiver.machine;
    boundary.relay = async packet => {
      const call = packet as SocketRpcRequestPayload;
      const installation = ManagedInstallationCapabilityRequestV1Schema.safeParse(call.params);
      if (acquire.automaticSignIn && installation.success && managed) {
        // Home's managed installation forwarder: it admits the requester's exact purpose on the
        // retained row and stamps it for the custodian controller's socket only.
        const requestId = mints.find(mint => mint.machineId === OWNER_MACHINE_ID)?.envelope.requestId;
        const origin = ManagedInstallationServerOriginV1Schema.parse({ kind: 'machine.managedInstallation.serverOrigin',
          actorAccountId: 'requester', custodianAccountId: 'owner',
          purpose: { ...readManagedInstallationPurposeV1(installation.data.params), requestId } });
        installationAnswers.push(installation.data.params);
        const forwarded = { ...installation.data, params: { ...installation.data.params, requestId } };
        controllerReceived.push(forwarded);
        return await receiver.manager.handleRequest({ method: call.method, params: forwarded, authorization: origin },
          undefined, 'authenticated_home_socket');
      }
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
  /** The member approves an Ask through its own daemon's ingress, as Home delivers the decision. */
  const approve = async (artifactId: unknown) => {
    const owner = h.daemon.externalActionIngressOwner;
    if (!owner) throw new Error('Missing member external Action ingress');
    const target = { kind: 'machine' as const, machineId: 'machine' };
    const decideInput = { artifactId: String(artifactId), decision: 'approve', serverIdentityId: homeId };
    const envelope = ExternalActionRequestEnvelopeSchema.parse({ v: 1, requestId: 'decide-acquire', target, input: decideInput });
    return await executeExternalAction({ ...owner, actionId: 'approval.request.decide', envelope,
      executionAuthorization: ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'decide-root', binding: {
        accountId: 'requester', custodianAccountId: 'requester', serverIdentityId: homeId,
        authentication: { kind: 'account', tokenEpoch: 0 }, accountEncryptionMode: 'plain',
        machineId: 'machine', installationId: h.f.installation.installationId, admittedMachineRole: 'manage',
        actionId: 'approval.request.decide', requestId: envelope.requestId, target,
        approvalDecisionAdmission: projectExternalActionApprovalDecisionAdmissionV1(decideInput),
        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) } }),
      principal: { accountId: 'requester', authority: 'present_user', authentication: { kind: 'account', tokenEpoch: 0 } },
      currentMachineId: 'machine', currentAccountId: 'requester', currentInstallationId: h.f.installation.installationId,
      verifyExecutionAuthorization: async () => true, signal: h.signal });
  };
  const retry = async () => {
    // The test Home admits the exact requester's Retry. Keep the controller's
    // real operation runner and native bootstrap below that admission boundary.
    if (!controllerMachine) throw new Error('Missing managed controller');
    const installation = readInstallationIdentityIfExistsSync();
    if (!installation || installation.installationId !== controller.installationId) throw new Error('Missing controller installation');
    const actionId = MANAGED_BOOTSTRAP_RETRY_ACTION_ID_V1;
    const target = { kind: 'machine' as const, machineId: OWNER_MACHINE_ID };
    const input = { homeId, managedId: 'delegated-guest', expectedIntentRevision: 0 };
    const envelope = ExternalActionRequestEnvelopeSchema.parse({ v: 1, requestId: 'retry-sign-in', target, input });
    const authentication = { kind: 'account' as const, tokenEpoch: 0 };
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'member-acquire-root', binding: {
      accountId: 'requester', custodianAccountId: 'owner', serverIdentityId: homeId, authentication, accountEncryptionMode: 'plain',
      machineId: OWNER_MACHINE_ID, installationId: controller.installationId, admittedMachineRole: 'manage', actionId,
      requestId: envelope.requestId, target, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
      managedAdmission: { actionId, input: { ...input, guestCli: { source: 'home-payload', line: '0.3', channel: 'stable' } } },
    } });
    const isCurrent = async () => !h.signal.aborted;
    const projected = await projectExternalActionRequesterHttpAuthorization({
      authorization, target, serverId: controllerServerId, serverIdentityId: homeId,
      serverHttpBaseUrl: 'https://session-home.test', installationId: installation.installationId,
      privateKey: installation.privateKey, rootAdmitted: true, isCurrent,
    });
    if (!projected) throw new Error('The fixture did not admit the retry');
    const adapter = createDaemonManagedMachineActionAdapter({
      credentials: ownerCredentials, machineId: OWNER_MACHINE_ID,
      serverId: controllerServerId, serverBaseUrl: 'https://session-home.test', installationIdentity: installation,
      resolveCurrentMachineExecutionOriginContext: async () => ({ machineId: OWNER_MACHINE_ID, serverIdentityId: homeId }),
      acquireRuntimeRegistryLease: () => h.plugin.controller.acquireRuntimeRegistry(),
      managedProviderOperationAuthority: createControllerProviderAuthority(),
    });
    return await controllerMachine.observeActionExecution({ actionId, input, actionRequestId: envelope.requestId,
      response: 'admission', rpcContext: { signal: h.signal, verifyMachineAdmissionCurrent: isCurrent,
        machineAdmission: { actorAccountId: 'requester', custodianAccountId: 'owner', machineId: OWNER_MACHINE_ID,
          installationId: controller.installationId, role: 'manage', encryptionMode: 'plain' } },
      execute: async operation => ({ ok: true, result: await adapter({ actionId, input, signal: operation.signal, context: {
        ...operation, surface: 'ui', authority: 'present_user', runtimeAccountId: 'requester',
        actionCaller: { kind: 'host' }, actionsSettings: policyFor(acquire.memberPolicy),
        externalActionExecutionAuthorization: projected, externalActionTarget: target, originalActionEnvelope: envelope,
      } }) }),
    });
  };
  return { h, credentials, controller, outcome, paths, homeRequests, mints, relayed, delivered, atDelivery, homeRelayed, homeRelayResults, controllerSteps, controllerReports, approve, receiverManager,
    approvals, readApproval, controllerRequests, requesterOccurrences, retry, installationAnswers, pairingApprovals, controllerReceived };
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

/**
 * The Agent plugin plus a local provisioner, installed once in the shared plugin
 * runtime, so the owner's controller can run the delegated preset's provider.
 */
let delegatedCompute: Readonly<{ plugin: NonNullable<Parameters<typeof createInstalledProjectAgentDaemonFixture>[3]>;
  provisionerId: string }> | undefined;
function delegatedComputePlugin(guestEnrollment?: true, pairingLifetimeMs?: number) {
  if (!guestEnrollment && delegatedCompute) return delegatedCompute;
  const native = nativeFixture({ credentialPurposes: [] });
  const nativeManifest = native.manifest;
  native.retire();
  const provisioner = nativeManifest.contributes.machineProvisioners[0]!;
  const result = { provisionerId: provisioner.id, plugin: {
    manifest: createPluginManifestV2Fixture({ id: 'acme.project-launch', contributes: {
      agents: [{ id: 'agent', title: 'Project launch Agent', runtime: { kind: 'custom' }, primary: 'sessions',
        capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } } }],
      machineProvisioners: [{ ...provisioner, billing: { location: 'local', stoppedBilling: 'not-billed' } }],
      actions: nativeManifest.contributes.actions,
    } }), files: {
      'agent.mjs': `export function factory() { return { sessions: { open() { throw new Error('No Agent open at authorization'); } } }; }`,
      'daemon.mjs': `import { factory } from './agent.mjs';
        ${guestEnrollment ? pendingEnrollmentGuestRoleSource({ pluginId: 'acme.project-launch', localId: provisioner.id, homeId, pairingLifetimeMs }) : ''}
        export function activate(api) {
          api.agents.register('agent', factory, { sessionRunnerFactory: { module: './agent.mjs', export: 'factory', runtimeApiVersion: 1 } });
          ${nativeManifest.contributes.actions.map(({ id }) => `api.actions.register(${JSON.stringify(id)}, async input => ${guestEnrollment
            ? `nativeGuestRoles[${JSON.stringify(id)}]?.(input) ?? (${JSON.stringify(roleResult(id))})` : id === 'acquire'
              ? `({ kind: 'rejected', code: 'provider_unavailable' })` : `(${JSON.stringify(roleResult(id))})`});`).join('\n')}
        }`,
    } } };
  if (!guestEnrollment) delegatedCompute = result;
  return result;
}

/** The owner's provider authority; the local provisioner needs no connected Account material. */
function createControllerProviderAuthority() {
  const unavailable = async (): Promise<never> => { throw new Error('The local provisioner does not need connected Account material'); };
  return createManagedProviderOperationAuthority({ materializationBaseDir: '/unused-member-delegated-acquire',
    purposeBindingOwner: createConnectedAccountPurposeBindingOwner({
      store: { read: async () => ({ v: 1, bindings: [] }), update: unavailable, subscribe: () => ({ dispose() {} }) },
      selectTarget: unavailable, resolveTarget: unavailable, materializeAccount: unavailable,
      projectTargetAccounts: unavailable, assertTargetAccountMaterializable: unavailable,
    }), requestAuthRegistry: createConnectedAccountRequestAuthSubjectRegistry(), resolveRequestAuthHttpPort: () => 43123,
    createRedactionLease: () => ({ add() {}, close() {} }) });
}

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

// A member whose grant on the owner's controller was revoked after Home signed
// the root gets the typed target refusal, not an internal error, and nothing is delivered.
it("a member's acquire on the owner's controller after the member's grant was revoked is refused as an unavailable target", async () => {
  const run = await runMemberAcquire({ controller: 'owner machine', namesController: true, memberPolicy: 'ask', controllerGrant: 'revoked' });
  expect(run.outcome, JSON.stringify(run.outcome)).toMatchObject({ ok: true, result: { kind: 'action.execution',
    outcome: { ok: false, errorCode: 'target_unavailable', details: { code: 'target_unavailable', reason: 'machine_check_failed' } } } });
  expect(run.relayed).toEqual([]);
  expect(run.approvals('requester')).toEqual([]);
  expect(run.approvals('owner')).toEqual([]);
}, 120_000);

// Ruling O-MACH 2026-11-25 01:03Z: a delegated Team preset's acquire is the member's
// own local Action. The member's approval owner asks first; after approval the
// effect hands off to the resolve-acquire / Home relay route as the member's own invocation.
it("a member's Agent acquire through the owner's delegated Team preset asks the member once, then reaches the owner's controller through Home's relay as the member's own invocation", async () => {
  const run = await runMemberAcquire({ controller: 'owner machine', namesController: false, memberPolicy: 'ask', delegated: true });
  const [ask] = run.approvals('requester');
  expect(run.outcome, JSON.stringify({ outcome: run.outcome, homeRequests: run.homeRequests })).toMatchObject({ ok: true,
    result: { kind: 'action.execution', outcome: { ok: true, result: { kind: 'approval_request_created', artifactId: ask?.id } } } });
  expect(run.approvals('requester')).toHaveLength(1);
  expect(run.approvals('owner')).toEqual([]);
  expect(await run.readApproval(ask?.id)).toMatchObject({
    preview: { accountSignIn: 'requester_confirms' },
  });
  // Nothing reached the controller before approval.
  expect(run.relayed).toEqual([]);
  expect(run.homeRelayed).toEqual([]);
  // The only Home admission so far is for the member's own Machine; none names the controller.
  expect(run.mints.map(mint => mint.machineId)).not.toContain(OWNER_MACHINE_ID);
  expect(run.paths.some(path => path.startsWith('POST /v1/machines/managed/controller/'))).toBe(false);
  expect(run.paths).not.toContain(`GET /v1/machines/${OWNER_MACHINE_ID}`);
  const decided = await run.approve(ask?.id);
  expect(run.homeRelayed, JSON.stringify({ decided, homeRequests: run.homeRequests })).toHaveLength(1);
  const root = run.homeRelayed[0]?.executionAuthorization?.binding;
  // The member's own invocation: no Session origin, Home's delegation signed in.
  expect(root).toMatchObject({ accountId: 'requester', custodianAccountId: 'owner', machineId: OWNER_MACHINE_ID,
    actionId: 'machines.managed.acquire', managedAcquireDelegation: true });
  expect(root?.sessionActionOrigin).toBeUndefined();
  expect(root?.sessionActionSource).toBeUndefined();
  // What Home received at mint for the controller: the member's own request, no Session origin.
  const controllerMints = run.mints.filter(mint => mint.machineId === OWNER_MACHINE_ID);
  expect(controllerMints).toHaveLength(1);
  expect(controllerMints[0]?.sessionActionOrigin).toBeUndefined();
  expect(controllerMints[0]?.sessionActionSource).toBeUndefined();
  // The owner's controller opens the relayed root and admits exactly one allocation on Home's row.
  expect(decided, JSON.stringify({ steps: run.controllerSteps, relay: run.homeRelayResults })).toMatchObject({ kind: 'response',
    response: { execution: { ok: true, result: { status: 'executed', execution: { ok: true,
      result: { managedId: 'delegated-guest', operation: { operationId: expect.any(String) } } } } } } });
  const operationId = (decided as { response: { execution: { result: { execution: { result: { operation: { operationId: string } } } } } } })
    .response.execution.result.execution.result.operation.operationId;
  // Observe the accepted acquisition through the controller's real operation read, in the member's admitted scope.
  const terminal = await run.receiverManager!.invokeLocal(ACTION_OPERATION_RPC_METHODS_V2.get, { operationId, waitForTerminal: true },
    { signal: run.h.signal, rpcContext: { machineAdmission: { actorAccountId: 'requester', custodianAccountId: 'owner',
      machineId: OWNER_MACHINE_ID, installationId: run.controller.installationId, role: 'manage', encryptionMode: 'plain' },
      verifyMachineAdmissionCurrent: async () => true } });
  // One allocation: one admitted row, one submission; then the provider's one native child acquisition.
  expect(run.controllerSteps.filter(step => step.endsWith(' admit')), JSON.stringify({ steps: run.controllerSteps, terminal })).toHaveLength(1);
  expect(run.controllerSteps.filter(step => step.endsWith(' submit')), JSON.stringify({ steps: run.controllerSteps, terminal })).toHaveLength(1);
  // The fixture provider answers its one native child acquisition with a typed refusal; the controller reports it.
  expect(run.controllerReports, JSON.stringify({ steps: run.controllerSteps, terminal })).toEqual([expect.objectContaining({
    managedId: 'delegated-guest', requestId: controllerMints[0]?.envelope.requestId,
    presetContent: { t: 'plain', v: expect.objectContaining({ nativeResult: { kind: 'rejected', code: 'provider_unavailable' } }) } })]);
  // The acquisition is the member's operation on the owner's Machine, settled with the provider's typed cause.
  expect(terminal).toMatchObject({ kind: 'found', operation: { actionId: 'machines.managed.acquire', state: 'failed',
    scope: { accountId: 'requester', machineId: OWNER_MACHINE_ID }, error: { errorCode: 'provider_unavailable' } } });
  expect(run.approvals('owner')).toEqual([]);
  expect(run.relayed).toEqual([]);
}, 180_000);

it.each(['pending', 'expired'] as const)('delivers the %s sign-in occurrence from an approved delegated Agent acquire to its requester', async lifecycle => {
  const run = await runMemberAcquire({ controller: 'owner machine', namesController: false, memberPolicy: 'ask',
    delegated: true, guestEnrollment: true, ...(lifecycle === 'expired' ? { guestPairingLifetimeMs: 3_000 } : {}) });
  const [ask] = run.approvals('requester');
  expect(ask).toBeDefined();
  const decided = await run.approve(ask!.id);
  expect(decided).toMatchObject({ kind: 'response', response: { execution: { ok: true, result: {
    status: 'executed', execution: { ok: true, result: { managedId: 'delegated-guest', operation: { operationId: expect.any(String) } } },
  } } } });
  const operationId = (decided as { response: { execution: { result: { execution: { result: { operation: { operationId: string } } } } } } })
    .response.execution.result.execution.result.operation.operationId;
  const owner = run.receiverManager!;
  const context = { signal: run.h.signal, rpcContext: { machineAdmission: { actorAccountId: 'requester', custodianAccountId: 'owner',
    machineId: OWNER_MACHINE_ID, installationId: run.controller.installationId, role: 'manage' as const, encryptionMode: 'plain' as const },
    verifyMachineAdmissionCurrent: async () => true } };
  const raw = await owner.invokeLocal(ACTION_OPERATION_RPC_METHODS_V2.get,
    { operationId, waitForTerminal: true, includeManagedPrompt: true }, context);
  const observed = ActionOperationGetV1ResponseSchema.parse(raw);
  expect(observed, observed.kind === 'found' ? JSON.stringify({ state: observed.operation.state,
    error: observed.operation.error, progress: observed.operation.progress, steps: run.controllerSteps }) : undefined)
    .toMatchObject({ kind: 'found', operation: { state: 'running', domainRef: { bootstrapTask: {
    id: expect.any(String), prompt: { kind: 'auth.approveRemoteProvisioning' },
  } } } });
  const domain = observed.kind === 'found' ? observed.operation.domainRef : undefined;
  if (domain?.kind !== 'managedMachine' || !domain.bootstrapTask) throw new Error('Missing managed enrollment task');
  const pending = {
    homeId, requesterAccountId: 'requester', managedId: 'delegated-guest', operationId,
    taskId: domain.bootstrapTask!.id, promptKind: 'auth.approveRemoteProvisioning', state: 'pending',
  };
  await vi.waitFor(() => expect(run.requesterOccurrences).toEqual([pending]));
  if (lifecycle === 'expired') {
    const readTerminal = () => owner.invokeLocal(ACTION_OPERATION_RPC_METHODS_V2.get,
      { operationId, waitForTerminal: true }, context);
    const terminal = await readTerminal();
    expect(run.requesterOccurrences).toEqual([pending, { ...pending, state: 'expired' }]);
    expect(terminal).toMatchObject({ kind: 'found', operation: { state: 'failed', error: {
      errorCode: 'auth_request_expired', failureCause: { errorCode: 'auth_request_expired', phase: 'ssh.auth.wait' },
    } } });
    const retried = await run.retry();
    if (!retried.ok) throw new Error(`Retry was not accepted: ${retried.errorCode}`);
    const { operationId: retryOperationId } = ActionOperationAcceptedResultSchema.parse(retried.result);
    expect(retryOperationId).not.toBe(operationId);
    const retryPrompt = ActionOperationGetV1ResponseSchema.parse(await owner.invokeLocal(ACTION_OPERATION_RPC_METHODS_V2.get,
      { operationId: retryOperationId, waitForTerminal: true, includeManagedPrompt: true }, context));
    const retryDomain = retryPrompt.kind === 'found' ? retryPrompt.operation.domainRef : undefined;
    expect(retryDomain, retryPrompt.kind === 'found' ? JSON.stringify(retryPrompt.operation.error) : undefined)
      .toMatchObject({ kind: 'managedMachine', id: pending.managedId, bootstrapTask: { id: expect.any(String),
      prompt: { kind: pending.promptKind } } });
    if (retryDomain?.kind !== 'managedMachine' || !retryDomain.bootstrapTask) throw new Error('Missing retry enrollment task');
    expect(retryDomain.bootstrapTask.id).not.toBe(pending.taskId);
    await vi.waitFor(() => expect(run.requesterOccurrences.slice(0, 3))
      .toEqual([pending, { ...pending, state: 'expired' }, {
        ...pending, operationId: retryOperationId, taskId: retryDomain.bootstrapTask!.id,
      }]));
    expect(await readTerminal()).toEqual(terminal);
  }
  expect(run.approvals('owner')).toEqual([]);
}, 180_000);

// Owner ruling 2026-11-26: the member's approval of the acquire, or their "allow" setting, covers signing the
// guest into their Account. The member's own daemon answers exactly that operation's sign-in question with its
// own sign-in; the owner's controller receives only the answer.
it.each(['ask', 'allow'] as const)("a member's Agent acquire under %s signs its guest into the member's Account from the member's own daemon, with no second question and nothing of the member's sign-in on the owner's controller", async memberPolicy => {
  const run = await runMemberAcquire({ controller: 'owner machine', namesController: false, memberPolicy,
    delegated: true, guestEnrollment: true, automaticSignIn: true });
  expect(run.approvals('requester')).toHaveLength(memberPolicy === 'ask' ? 1 : 0);
  let controllerResult: unknown;
  if (memberPolicy === 'ask') {
    const [ask] = run.approvals('requester');
    const decision = await run.approve(ask!.id);
    if (decision.kind !== 'response' || decision.response.v !== 1 || !decision.response.execution.ok) {
      throw new Error('The member’s approval did not return an execution');
    }
    const result = decision.response.execution.result as { status?: unknown; execution?: unknown };
    expect(result.status).toBe('executed');
    controllerResult = ApprovalExecutionV2Schema.parse(result.execution).result;
  } else {
    expect(run.outcome).toMatchObject({ ok: true, result: { outcome: { ok: true } } });
    await vi.waitFor(() => expect(run.homeRelayResults).toHaveLength(1), { timeout: 60_000 });
    const relayed = parseExternalActionDaemonDispatchResultV1(run.homeRelayResults[0]);
    if (relayed?.kind !== 'response' || !relayed.prepared.response.execution.ok) {
      throw new Error('The controller did not accept the member’s acquire');
    }
    controllerResult = relayed.prepared.response.execution.result;
  }
  const accepted = ManagedAcceptedV1Schema.parse(controllerResult);
  expect(accepted.managedId).toBe('delegated-guest');
  expect(accepted.operation).toBeDefined();
  const operationId = accepted.operation!.operationId;
  // Nobody in the test answers the question: the member's daemon does, for this operation only.
  await vi.waitFor(() => expect(run.installationAnswers).toEqual([
    expect.objectContaining({ homeId, managedId: accepted.managedId, operationId, expectedPromptKind: 'auth.approveRemoteProvisioning',
      delivery: { kind: 'terminalPairing' } }),
    expect.objectContaining({ homeId, managedId: accepted.managedId, operationId, expectedPromptKind: 'auth.approveRemoteProvisioning',
      answer: { approved: true } }),
  ]), { timeout: 60_000 });
  expect(run.approvals('requester')).toHaveLength(memberPolicy === 'ask' ? 1 : 0);
  // The member's own sign-in approved the guest's pairing at Home.
  expect(run.pairingApprovals).toEqual(['requester']);
  await vi.waitFor(() => expect(run.requesterOccurrences).toContainEqual(expect.objectContaining({ operationId, state: 'answered' })));
  // The owner's controller never received the member's credential token.
  expect(JSON.stringify(run.controllerReceived)).not.toContain(run.credentials.token);
  expect(run.homeRequests.filter(request => request.endsWith('POST /v1/auth/response'))).toEqual(['requester POST /v1/auth/response']);
  expect(run.approvals('owner')).toEqual([]);
}, 180_000);

it("a member's approved Agent acquire on a delegated Team preset that Home no longer routes for the member keeps Home's typed refusal and reaches nothing", async () => {
  const run = await runMemberAcquire({ controller: 'owner machine', namesController: false, memberPolicy: 'ask', delegated: true, routingRefused: true });
  const [ask] = run.approvals('requester');
  const decided = await run.approve(ask?.id);
  expect(JSON.stringify(decided)).toContain('permission_denied');
  expect(run.homeRelayed).toEqual([]);
  expect(run.mints.map(mint => mint.machineId)).not.toContain(OWNER_MACHINE_ID);
  expect(run.approvals('owner')).toEqual([]);
}, 180_000);

/** Every Home request from now on, with the Account its bearer names and the signed root it carries. */
function recordHomeTraffic() {
  const seen: { account: string | null; method: string; path: string; root: string | null; signed: boolean; body?: unknown }[] = [];
  const header = (config: unknown, name: string) => {
    const headers = (config as { headers?: Record<string, unknown> } | undefined)?.headers ?? {};
    const value = Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1];
    return typeof value === 'string' ? value : null;
  };
  const record = (method: string, url: unknown, config: unknown, body?: unknown) => seen.push({ account: readRequestAccount(config),
    method, path: new URL(String(url)).pathname, root: header(config, EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER),
    signed: header(config, EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER) !== null, ...(body === undefined ? {} : { body }) });
  const get = vi.mocked(axios.get).getMockImplementation()!;
  const post = vi.mocked(axios.post).getMockImplementation()!;
  vi.mocked(axios.get).mockImplementation(async (...args) => { record('GET', args[0], args[1]); return await get(...args); });
  vi.mocked(axios.post).mockImplementation(async (...args) => { record('POST', args[0], args[2], args[1]); return await post(...args); });
  const fetchBoundary = globalThis.fetch;
  vi.stubGlobal('fetch', async (...args: Parameters<typeof fetch>) => {
    const input = args[0];
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    record(args[1]?.method ?? 'GET', url, { headers: Object.fromEntries(new Headers(args[1]?.headers).entries()) });
    return await fetchBoundary(...args);
  });
  return seen;
}

// What the owner's sign-in may reach while its controller serves a member's
// delegated acquire: its own identity at Machine RPC ingress, its own Account
// mode, and the preset the member's Home-signed root names. Every write about
// the member's allocation spends that root instead (BL72, TS-SECURITY-12 N2).
const OWNER_SIGN_IN_READS = new Set(['GET /v1/account/profile', 'GET /v1/account/encryption/currentness',
  'POST /v1/machines/presets/get']);

/** The member approves its delegated Agent acquire; the owner's controller serves it to the provider's typed answer. */
async function runApprovedDelegatedAcquire() {
  const run = await runMemberAcquire({ controller: 'owner machine', namesController: false, memberPolicy: 'ask', delegated: true });
  const [ask] = run.approvals('requester');
  const seen = recordHomeTraffic();
  const decided = await run.approve(ask?.id);
  const operationId = (decided as { response: { execution: { result: { execution: { result: { operation: { operationId: string } } } } } } })
    .response.execution.result.execution.result.operation.operationId;
  const terminal = await run.receiverManager!.invokeLocal(ACTION_OPERATION_RPC_METHODS_V2.get, { operationId, waitForTerminal: true },
    { signal: run.h.signal, rpcContext: { machineAdmission: { actorAccountId: 'requester', custodianAccountId: 'owner',
      machineId: OWNER_MACHINE_ID, installationId: run.controller.installationId, role: 'manage', encryptionMode: 'plain' },
      verifyMachineAdmissionCurrent: async () => true } });
  return { run, seen, terminal };
}

it("a member's approved delegated acquire runs on the owner's controller as the member: each managed-row write and Home check spends the member's signed root, and the owner's sign-in reaches only its own identity, mode and the named preset", async () => {
  const { run, seen, terminal } = await runApprovedDelegatedAcquire();
  // The root Home signed for the owner's controller is the member's own invocation.
  expect(run.homeRelayed.map(body => body.executionAuthorization?.binding)).toEqual([expect.objectContaining({
    accountId: 'requester', custodianAccountId: 'owner', machineId: OWNER_MACHINE_ID, managedAcquireDelegation: true })]);
  // The member's operation on the owner's Machine, settled with the provider's typed cause.
  expect(terminal).toMatchObject({ kind: 'found', operation: { scope: { accountId: 'requester', machineId: OWNER_MACHINE_ID },
    state: 'failed', error: { errorCode: 'provider_unavailable' } } });
  const managedWrites = seen.filter(entry => entry.path.startsWith('/v1/machines/managed/controller/'));
  expect(managedWrites.map(entry => entry.path.slice('/v1/machines/managed/controller/'.length)))
    .toEqual(expect.arrayContaining(['admit', 'submit', 'report']));
  // No managed-row write carries the owner's bearer; each one spends the member's root, signed by the controller installation.
  for (const write of managedWrites) expect(write, write.path).toMatchObject({ account: null, root: 'member-acquire-root', signed: true });
  // Every root Home is asked to verify during the acquire is bound to the member's Account.
  const verified = seen.filter(entry => entry.path.endsWith('/execution-authorization/verify'));
  expect(verified.length).toBeGreaterThan(0);
  for (const check of verified) expect(check.body).toMatchObject({ binding: { accountId: 'requester' } });
  // The owner's sign-in reads nothing of the owner's Account data for the member, and writes nothing.
  const ownerRequests = seen.filter(entry => entry.account === 'owner');
  expect(ownerRequests.map(entry => `${entry.method} ${entry.path}`).filter(request => !OWNER_SIGN_IN_READS.has(request)),
    JSON.stringify(ownerRequests.map(({ body: _body, ...entry }) => entry))).toEqual([]);
  // Its one preset read names the preset the member's signed envelope selected.
  expect(ownerRequests.filter(entry => entry.path === '/v1/machines/presets/get').map(entry => entry.body))
    .toEqual([{ homeId, id: 'team-preset' }]);
  expect(run.approvals('owner')).toEqual([]);
}, 180_000);

it("the owner's controller refuses a member's delegated acquire root carrying another Account, or the owner's own, and a raw dispatch without a Home-signed root, with typed causes and nothing allocated or run as the owner", async () => {
  // Control: the member's real relayed root reaches the controller and allocates once.
  const { run, seen } = await runApprovedDelegatedAcquire();
  expect(run.controllerSteps.filter(step => step.endsWith(' admit'))).toHaveLength(1);
  const relayed = run.homeRelayed[0]!;
  const signed = relayed.executionAuthorization!;
  // Home answers verification for exactly the binding it signed under that token.
  const post = vi.mocked(axios.post).getMockImplementation()!;
  let homeVerifies = true;
  vi.mocked(axios.post).mockImplementation(async (...args) => {
    if (homeVerifies && new URL(String(args[0])).pathname.endsWith('/execution-authorization/verify'))
      return { status: 200, data: { ok: JSON.stringify((args[1] as { binding?: unknown }).binding) === JSON.stringify(signed.binding) } };
    return await post(...args);
  });
  const deliver = async (params: unknown, actorAccountId: string) => {
    const before = { steps: run.controllerSteps.length, reports: run.controllerReports.length, seen: seen.length };
    const result = await run.receiverManager!.handleRequest({ method: `${OWNER_MACHINE_ID}:${EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1}`,
      params, authorization: ACTION_API_SERVER_ORIGIN, machineAdmission: { actorAccountId, custodianAccountId: 'owner',
        machineId: OWNER_MACHINE_ID, installationId: run.controller.installationId, role: 'manage', encryptionMode: 'plain' } },
      undefined, 'authenticated_home_socket');
    const requests = seen.slice(before.seen);
    return { result, steps: run.controllerSteps.slice(before.steps), reports: run.controllerReports.length - before.reports,
      ownerRequests: requests.filter(entry => entry.account === 'owner').map(entry => entry.path),
      managedWrites: requests.filter(entry => entry.path.startsWith('/v1/machines/managed/')).map(entry => entry.path) };
  };
  const dispatch = (accountId: string, principalAccountId = accountId) => JSON.parse(JSON.stringify({
    actionId: 'machines.managed.acquire', envelope: relayed.envelope, executionAuthorization: { ...signed, binding: { ...signed.binding, accountId } },
    principal: { accountId: principalAccountId, authority: 'account_automation', authentication: { kind: 'terminal', tokenEpoch: 0 } },
    placement: { machineId: OWNER_MACHINE_ID, target: relayed.envelope.target } })) as unknown;
  const nothing = { steps: [], reports: 0, ownerRequests: [], managedWrites: [] };
  const refusedEnvelope = { kind: 'invalid_request', errorCode: 'invalid_envelope', requestId: relayed.envelope.requestId };
  const forbidden = { error: 'Forbidden', errorCode: 'RPC_FORBIDDEN', effectAttempted: false };
  // A third Account, consistently swapped into the root, its principal and Home's admission.
  expect(await deliver(dispatch('mallory'), 'mallory')).toEqual({ result: refusedEnvelope, ...nothing });
  // The owner's own Account forged into the member's root.
  expect(await deliver(dispatch('owner'), 'owner')).toEqual({ result: refusedEnvelope, ...nothing });
  // Even where Home would wrongly verify the altered root, the controller codec is sealed to the member's binding.
  homeVerifies = false;
  expect(await deliver(dispatch('mallory'), 'mallory')).toEqual({ result: refusedEnvelope, ...nothing });
  expect(await deliver(dispatch('owner'), 'owner')).toEqual({ result: refusedEnvelope, ...nothing });
  homeVerifies = true;
  // The member's root under another principal, or under another admitted actor.
  expect(await deliver(dispatch('requester', 'mallory'), 'mallory')).toEqual({ result: forbidden, ...nothing });
  expect(await deliver(dispatch('requester'), 'mallory')).toEqual({ result: forbidden, ...nothing });
  // BL40 shape: the dispatch with the member's context and no Home-signed root.
  const { executionAuthorization: _root, ...unsigned } = dispatch('requester') as Record<string, unknown>;
  expect(await deliver(unsigned, 'requester')).toEqual({ result: forbidden, ...nothing });
  expect(run.approvals('owner')).toEqual([]);
}, 180_000);

it("a Use guest's Session on another person's Machine acquires an owner's delegated Team preset as the guest: the Session host spends only the guest's sign-in, and the controller root Home signs is the guest's", async () => {
  const run = await runMemberAcquire({ controller: 'owner machine', namesController: false, memberPolicy: 'allow', delegated: true,
    sessionHost: 'custodian machine' });
  expect(run.outcome, JSON.stringify(run.outcome)).toMatchObject({ ok: true, result: { kind: 'action.execution',
    outcome: { ok: true, result: { status: 'accepted' } } } });
  await vi.waitFor(() => expect(run.homeRelayResults).toHaveLength(1), { timeout: 60_000 });
  // The Session host never authenticates with its custodian's own sign-in for the guest's acquire.
  expect(run.homeRequests.filter(request => request.startsWith('custodian '))).toEqual([]);
  // Home mints the controller root and receives the relay from the guest's own sign-in.
  expect(run.mints.filter(mint => mint.machineId === OWNER_MACHINE_ID)).toHaveLength(1);
  expect(run.homeRequests).toEqual(expect.arrayContaining(['requester POST /v1/actions/machines.managed.acquire/execution-authorization',
    'requester POST /v1/actions/machines.managed.acquire']));
  expect(run.homeRelayed.map(body => body.executionAuthorization?.binding)).toEqual([expect.objectContaining({
    accountId: 'requester', custodianAccountId: 'owner', machineId: OWNER_MACHINE_ID, managedAcquireDelegation: true })]);
}, 180_000);
