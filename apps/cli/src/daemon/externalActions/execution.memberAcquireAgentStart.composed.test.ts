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
import { applyPermissionModeIntentSessionMetadata } from '@happier-dev/agents/session/state/metadataWriters';
import { readCarrierMutation } from '@/api/artifacts/accountArtifactStore.testkit';
import { artifactListResponse } from '@/testkit/http/artifactHome';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { configuration } from '@/configuration';
import { createAgentRuntimeDaemonServiceAuthorityPath, publishAgentRuntimeDaemonServiceAuthority } from '@/daemon/agentRuntime/sessionBridgeAuthorization';
import type { startDaemonControlServer } from '@/daemon/controlServer';
import { createInstalledProjectAgentDaemonFixture } from '@/daemon/testkit/installedProjectAgentDaemonFixture';
import { readBundledPluginAvailabilityHttpFixture } from '@/plugins/testkit/bundledPluginAvailabilityHttpFixture';
import { resetServerFeaturesClientForTests } from '@/features/serverFeaturesClient';
import { createCliApprovalsArtifactStore } from '@/session/actions/approvals/artifactStore';
import { ensureCliActionPolicySettings } from '@/session/actions/ensureCliActionPolicySettings';

const boundary = vi.hoisted(() => ({
  control: null as Parameters<typeof startDaemonControlServer>[0] | null,
}));
// The private OS listener and Home HTTP are the boundaries. Agent dispatch, the
// installed Session Account executor, its daemon executor and approval signer stay real.
vi.mock('@/daemon/controlServer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/daemon/controlServer')>()),
  startDaemonControlServer: async (
    input: Parameters<typeof startDaemonControlServer>[0],
  ) => {
    boundary.control = input;
    return { port: 43129, stop: async () => {} };
  },
}));

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

// The producer resolves the controller from the preset, so an acquire that
// names none is placed on that controller exactly as one that names it.
it.each(['names the preset controller', 'names no controller'] as const)("admits a Session agent's managed acquire with agentStart once on the installed daemon and signs the stamp into the root its Ask records (%s)", async controllerCase => {
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
        actionsSettingsV1: normalizeActionsSettingsV1({
          v: 1,
          actions: {
            'machines.managed.acquire': { approvalRequiredSurfaces: ['agent'] },
          },
        }),
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
  // A live Session reaches the private dispatcher through its runner's published
  // authority. The daemon's tracked record of it is what Session-caller currentness reads.
  const authority = await publishAgentRuntimeDaemonServiceAuthority({ happyHomeDir: h.f.directory,
    publicReleaseRing: configuration.publicReleaseRing,
    path: await createAgentRuntimeDaemonServiceAuthorityPath({ happyHomeDir: h.f.directory,
      publicReleaseRing: configuration.publicReleaseRing }),
    sessionId: h.sessionId, runner: h.runner, retainedAgent: h.retainedAgent, httpPort: 43129 });
  Object.assign(h.tracked, { agentRuntimeDaemonServiceAuthorityFilePath: authority.path,
    agentRuntimeDaemonServiceCapabilityHash: authority.capabilityDigest });
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
  const mints: ReturnType<
    typeof ExternalActionExecutionAuthorizationRequestV1Schema.parse
  >[] = [];
  let artifact: Record<string, unknown> | undefined;
  onTestFailed(() => console.error('Member acquire boundary outcomes', JSON.stringify({ paths,
    origins: mints.map(mint => mint.sessionActionOrigin), artifact: artifact?.id ?? null })));
  vi.mocked(axios.get).mockImplementation(async (...args) => {
    const path = new URL(String(args[0])).pathname;
    paths.push(`GET ${path}`);
    // No Role or prompt Artifacts exist for this Account; the Ask is the only Artifact.
    if (path === '/v1/artifacts')
      return { status: 200, data: artifactListResponse(String(args[0]), artifact ? [artifact] : []) };
    // The Account has no Action automations; Home answers its empty index.
    if (path === AUTOMATION_ACTION_INDEX_HTTP_PATH_V1)
      return { status: 200, data: ActionAutomationIndexV1Schema.parse({ v: 1, rows: [] }) };
    // The live calling Session records the permission mode its turn runs under,
    // through the same metadata writer its runner uses.
    if (path === `/v2/sessions/${h.sessionId}`) {
      const read = await homeRead(...args);
      const session = read.data.session;
      return { ...read, data: { ...read.data, session: { ...session, metadata: JSON.stringify(
        applyPermissionModeIntentSessionMetadata(JSON.parse(session.metadata), { permissionMode: 'default', updatedAt: 1 })) } } };
    }
    if (path.startsWith('/v1/artifacts/'))
      return artifact && path === '/v1/artifacts/' + artifact.id
        ? { status: 200, data: artifact }
        : { status: 404, data: { error: 'not_found' } };
    return await homeRead(...args);
  });
  vi.mocked(axios.post).mockImplementation(async (...args) => {
    const path = new URL(String(args[0])).pathname;
    paths.push(`POST ${path}`);
    // The Agent target's plugin availability is a Home read.
    const availability = readBundledPluginAvailabilityHttpFixture(path, args[1]);
    if (availability !== undefined) return { status: 200, data: availability };
    if (
      path === '/v1/artifacts' ||
      (artifact && path === '/v1/artifacts/' + artifact.id)
    ) {
      const mutation = readCarrierMutation(args[1]);
      const version = Number(artifact?.bodyVersion ?? 0) + 1;
      artifact = {
        ...artifact,
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
    // The Team preset names this Machine as its controller.
    if (path === '/v1/machines/presets/get')
      return { status: 200, data: { kind: 'found', preset: { id: 'team-preset', homeId, revision: 1,
        owner: { kind: 'account', accountId: 'requester' }, contentEncryptionMode: 'plain', recipients: [],
        content: { t: 'plain', v: { v: 1, name: 'Guest', launch: { provider: { pluginId: 'acme.compute', localId: 'vm' },
          schemaVersion: 1, name: 'guest', choices: {} } } },
        controller: { machineId: 'machine', installationId: h.f.installation.installationId } } } };
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
          custodianAccountId: 'requester',
          serverIdentityId: homeId,
          authentication: { kind: 'terminal', tokenEpoch: 0 },
          accountEncryptionMode: 'plain',
          machineId: 'machine',
          // The source daemon's own Installation signed this request.
          installationId: request.sessionActionSource?.installationId,
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
  const outcome = await h.dispatch({
    kind: 'action.execute',
    surface: 'agent',
    actionId: 'machines.managed.acquire',
    requestId: h.operationBase().requestId,
    toolCallId: 'tool-acquire',
    input: {
      selection: { kind: 'preset', homeId, id: 'team-preset', revision: 1 },
      // The preset's controller places the acquire on a Machine, so it needs a Machine root.
      ...(controllerCase === 'names the preset controller'
        ? { controller: { machineId: 'machine', installationId: h.f.installation.installationId } } : {}),
      agentStart: {
        directory: { kind: 'managed' },
        agentTarget: {
          kind: 'agent',
          identity: { pluginId: 'acme.project-launch', localId: 'agent' },
        },
      },
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
    input: { controller: { machineId: 'machine', installationId: h.f.installation.installationId } } });
  const stamp = mints[0]?.sessionActionOrigin?.agentStartAdmission;
  expect(stamp).toMatchObject({ workDepth: 1 });
  // The Ask retains that signed root, so its replay consumes the same admission.
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
}, 120_000);
