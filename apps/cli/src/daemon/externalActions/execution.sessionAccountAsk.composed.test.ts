import axios from 'axios';
import { expect, it, onTestFinished, vi } from 'vitest';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import {
  ExternalActionExecutionAuthorizationRequestV1Schema,
  ExternalActionExecutionAuthorizationV1Schema,
} from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { ApprovalRequestV2Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import { readCarrierMutation } from '@/api/artifacts/accountArtifactStore.testkit';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import type { startDaemonControlServer } from '@/daemon/controlServer';
import { createInstalledProjectAgentDaemonFixture } from '@/daemon/testkit/installedProjectAgentDaemonFixture';
import { resetServerFeaturesClientForTests } from '@/features/serverFeaturesClient';
import { createCliApprovalsArtifactStore } from '@/session/actions/approvals/artifactStore';
import { ensureCliActionPolicySettings } from '@/session/actions/ensureCliActionPolicySettings';

const boundary = vi.hoisted(() => ({
  control: null as Parameters<typeof startDaemonControlServer>[0] | null,
}));
// The private OS listener and Home HTTP are the boundaries. Agent dispatch,
// requester recovery, the credentialed executor and its approval signer stay real.
vi.mock('@/daemon/controlServer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/daemon/controlServer')>()),
  startDaemonControlServer: async (
    input: Parameters<typeof startDaemonControlServer>[0],
  ) => {
    boundary.control = input;
    return { port: 43129, stop: async () => {} };
  },
}));

const homeId = 'srv_session_account_ask';
const homeUrl = 'https://session-home.test';

/**
 * An Agent's native `session.list` with no Session row, under an Account rule that asks
 * (#137 C21.07): the runner forwards it to the daemon's Account-Action executor, which
 * prepares the Home root and builds the signed approval origin.
 */
async function forwardSessionList(
  options: Readonly<{
    permissionMode: 'default' | 'read-only';
    mintedInstallationId?: string;
  }>,
) {
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
          actions: { 'session.list': { approvalRequiredSurfaces: ['agent'] } },
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
  let artifact: Record<string, unknown> | undefined;
  const sessionListReads: unknown[] = [];
  vi.mocked(axios.get).mockImplementation(async (...args) => {
    const path = new URL(String(args[0])).pathname;
    if (path.startsWith('/v1/artifacts/'))
      return artifact && path === '/v1/artifacts/' + artifact.id
        ? { status: 200, data: artifact }
        : { status: 404, data: { error: 'not_found' } };
    const response = await homeRead(...args);
    if (path === `/v2/sessions/${h.sessionId}`)
      return {
        ...response,
        data: {
          ...response.data,
          session: {
            ...response.data.session,
            metadata: JSON.stringify({
              ...JSON.parse(response.data.session.metadata),
              permissionMode: options.permissionMode,
            }),
          },
        },
      };
    return response;
  });
  vi.mocked(axios.post).mockImplementation(async (...args) => {
    const path = new URL(String(args[0])).pathname;
    if (path === '/v2/sessions/query') {
      sessionListReads.push(args[1]);
      return {
        status: 200,
        data: { sessions: [], nextCursor: null, hasNext: false },
      };
    }
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
    if (path.endsWith('/execution-authorization/verify'))
      return { status: 200, data: { ok: true } };
    if (path !== '/v1/actions/session.list/execution-authorization')
      return await homeWrite(...args);
    // Home mints the root for the signed request it receives; this boundary echoes it.
    const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(
      args[1],
    );
    return {
      status: 200,
      data: ExternalActionExecutionAuthorizationV1Schema.parse({
        v: 1,
        token: 'session-list-root',
        binding: {
          accountId: 'requester',
          custodianAccountId: 'requester',
          serverIdentityId: homeId,
          authentication: { kind: 'terminal', tokenEpoch: 0 },
          accountEncryptionMode: 'plain',
          machineId: 'machine',
          installationId:
            options.mintedInstallationId ?? h.f.installation.installationId,
          admittedMachineRole: 'manage',
          actionId: 'session.list',
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
  // The daemon holds the Account's current policy from its settings feed; load it once here.
  await runWithServerHttpBaseUrl(homeUrl, () =>
    ensureCliActionPolicySettings(credentials, homeUrl),
  );
  const outcome = await h.dispatch({
    kind: 'action.execute',
    surface: 'agent',
    actionId: 'session.list',
    requestId: h.operationBase().requestId,
    input: {},
    toolCallId: 'tool-session-list',
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
      callerPermissionMode: options.permissionMode,
    },
  });
  const store = createCliApprovalsArtifactStore({
    credentials,
    serverHttpBaseUrl: homeUrl,
  });
  return {
    outcome,
    sessionListReads,
    readRequest: async () =>
      artifact
        ? ApprovalRequestV2Schema.parse(
            await store.approvalsGet({ artifactId: String(artifact.id) }),
          )
        : null,
  };
}

it.each(['default', 'read-only'] as const)(
  'asks for an Account "Ask first" Action an Agent forwards from a %s Session',
  async (permissionMode) => {
    const run = await forwardSessionList({ permissionMode });
    expect(run.outcome, JSON.stringify(run.outcome)).toMatchObject({
      ok: true,
      result: {
        kind: 'action.execution',
        outcome: { ok: true, result: { kind: 'approval_request_created' } },
      },
    });
    expect(run.sessionListReads).toHaveLength(0);
    // The signed origin records the Agent's admitted corpus, so replay lists the same Sessions.
    expect(await run.readRequest()).toMatchObject({
      status: 'open',
      actionId: 'session.list',
      executionOriginV1: {
        surface: 'agent',
        sessionListAccess: 'led_subtree',
        caller: { kind: 'session' },
        externalActionInputSignature: expect.any(String),
      },
    });
  },
);

it('does not sign an approval origin for an authorization minted for another installation', async () => {
  const run = await forwardSessionList({
    permissionMode: 'default',
    mintedInstallationId: 'another-installation',
  });
  expect(run.outcome).not.toMatchObject({ result: { outcome: { ok: true } } });
  expect(await run.readRequest()).toBeNull();
  expect(run.sessionListReads).toHaveLength(0);
});
