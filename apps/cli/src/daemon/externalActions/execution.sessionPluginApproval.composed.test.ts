import axios from 'axios';
import { expect, it, onTestFinished, vi } from 'vitest';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import {
  ExternalActionExecutionAuthorizationRequestV1Schema,
  ExternalActionExecutionAuthorizationV1Schema,
  ExternalActionRequestEnvelopeSchema,
  projectExternalActionApprovalDecisionAdmissionV1,
} from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
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
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { decodePlainArtifactStoredContent, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { ensureCliActionPolicySettings } from '@/session/actions/ensureCliActionPolicySettings';
import { logger } from '@/ui/logger';
import { executeExternalAction } from './executeExternalAction';

const boundary = vi.hoisted(() => ({
  control: null as Parameters<typeof startDaemonControlServer>[0] | null,
}));
// The private OS listener and Home HTTP are the boundaries. Agent dispatch, the
// contributed-Action Ask and the daemon's approval replay stay real.
vi.mock('@/daemon/controlServer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/daemon/controlServer')>()),
  startDaemonControlServer: async (
    input: Parameters<typeof startDaemonControlServer>[0],
  ) => {
    boundary.control = input;
    return { port: 43129, stop: async () => {} };
  },
}));

const homeId = 'srv_session_plugin_approval';
const homeUrl = 'https://session-home.test';
const pluginId = 'acme.project-launch';

/**
 * #137 C21.14 / D2: an Agent calls a daemon-placed plugin Action by its qualified id;
 * the runner forwards `action.invoke` with the contributor occurrence it discovered.
 * The Ask is approved through the installed daemon's `approval.request.decide` ingress.
 */
it.each(['current', 'input_changed', 'authorization_withdrawn', 'no_input'] as const)(
  'replays an approved Agent-initiated plugin Ask (%s)',
  async (scenario) => {
    onTestFinished(() => {
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      boundary.control = null;
      resetServerFeaturesClientForTests();
    });
    const effects: string[] = [];
    Reflect.set(globalThis, '__sessionPluginApprovalEffects', effects);
    const credentials = {
      token: `e30.${Buffer.from(
        JSON.stringify({
          sub: 'requester',
          tokenEpoch: 0,
          provenance: {
            v: 1,
            kind: 'terminal',
            authority: 'account_automation',
          },
        }),
      ).toString('base64url')}.signature`,
      encryption: null,
      credentialProvenance: 'stored_session' as const,
    };
    const h = await createInstalledProjectAgentDaemonFixture(
      () => boundary.control,
      undefined,
      true,
      {
        manifest: createPluginManifestV2Fixture({
          id: pluginId,
          contributes: {
            agents: [
              {
                id: 'agent',
                title: 'Project launch Agent',
                runtime: { kind: 'custom' },
                primary: 'sessions',
                capabilities: {
                  sessions: {
                    open: ['create'],
                    delivery: ['newTurn'],
                    cancel: true,
                  },
                },
              },
            ],
            actions: [
              {
                id: 'greet',
                execution: { target: 'daemon' },
                placementBindings: [],
                title: 'Greet the tester',
                scopes: ['global'],
                surfaces: ['agent', 'mcp', 'cli', 'ui'],
                dangerLevel: 'writesLocal',
                confirmation: {
                  title: 'Greet the tester',
                  body: 'Write a synthetic greeting.',
                },
                inputSchema: {
                  type: 'object',
                  properties: {},
                  additionalProperties: false,
                },
                resultSchema: {
                  type: 'object',
                  properties: { greeting: { type: 'string' } },
                  required: ['greeting'],
                  additionalProperties: false,
                },
              },
            ],
          },
        }),
        files: {
          'agent.mjs': `export function factory() { return { sessions: { open() { throw new Error('No Agent open'); } } }; }`,
          'daemon.mjs': `import { factory } from './agent.mjs';
      export function activate(api) {
        api.agents.register('agent', factory, { sessionRunnerFactory: { module: './agent.mjs', export: 'factory', runtimeApiVersion: 1 } });
        api.actions.register('greet', async () => { globalThis.__sessionPluginApprovalEffects.push('greet'); return { greeting: 'Hello tester' }; });
      }`,
        },
      },
      undefined,
      {
        pluginRuntimeOptions: {
          resolveCurrentMachineId: () => 'machine',
          resolveCurrentMachineExecutionOriginContext: async () => ({
            serverIdentityId: homeId,
            machineId: 'machine',
          }),
        },
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
    // The Session's live runner authority, as its host publishes it; replay rechecks it.
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
    const stale: unknown[] = [];
    // The replay's closed stale reason, at whichever log level the replay writes it.
    for (const level of ['debug', 'warnLocalFile'] as const)
      vi.spyOn(logger, level).mockImplementation((...args: unknown[]) => {
        if (args[0] === '[RPC] Contributed approval origin is stale')
          stale.push(args[1]);
      });
    const artifacts = new Map<string, Record<string, unknown>>();
    let rootWithdrawn = false;
    vi.mocked(axios.get).mockImplementation(async (...args) => {
      const path = new URL(String(args[0])).pathname;
      if (path.startsWith('/v1/artifacts/')) {
        const artifact = artifacts.get(path.slice('/v1/artifacts/'.length));
        return artifact
          ? { status: 200, data: artifact }
          : { status: 404, data: { error: 'not_found' } };
      }
      const response = await homeRead(...args);
      // The Session still runs in the permission mode the Agent asked from.
      if (path === `/v2/sessions/${h.sessionId}`)
        return {
          ...response,
          data: {
            ...response.data,
            session: {
              ...response.data.session,
              metadata: JSON.stringify({
                ...JSON.parse(response.data.session.metadata),
                permissionMode: 'read-only',
              }),
            },
          },
        };
      return response;
    });
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
      if (path === '/v1/actions/action.invoke/execution-authorization/verify')
        return rootWithdrawn
          ? { status: 403, data: { error: 'execution_authorization_revoked' } }
          : { status: 200, data: { ok: true } };
      if (path.endsWith('/execution-authorization/verify'))
        return { status: 200, data: { ok: true } };
      const minted = path.match(
        /^\/v1\/actions\/([^/]+)\/execution-authorization$/u,
      );
      if (!minted) return await homeWrite(...args);
      // Home mints the root for the signed request it receives; this boundary echoes it.
      const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(
        args[1],
      );
      const actionId = decodeURIComponent(minted[1]);
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
    const occurrenceId = h.plugin.registry.readPluginOccurrenceId?.(pluginId);
    if (!occurrenceId) throw new Error('Missing plugin occurrence');
    const asked = await h.dispatch({
      kind: 'action.execute',
      surface: 'agent',
      actionId: 'action.invoke',
      requestId: h.operationBase().requestId,
      toolCallId: 'tool-greet',
      input: {
        action: { pluginId, localId: 'greet' },
        ...(scenario === 'no_input' ? {} : { input: {} }),
        expectedContributorOccurrenceId: occurrenceId,
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
        callerPermissionMode: 'read-only',
        causalPermissionAuthority: {
          kind: 'admittedSessionInputV1',
          admittedPermissionCeiling: 'read-only',
        },
        actionRequestAttributionV1: {
          requestRef: 'input',
          requester: { serverId: homeId, accountId: 'requester' },
          persona: { serverId: homeId, sessionId: h.sessionId },
          origin: null,
        },
      },
    });
    if (scenario === 'no_input') {
      // Without an input there is no Ask to sign or replay: the call is refused before any Ask is recorded.
      expect(asked).toMatchObject({ ok: true, result: { kind: 'action.execution', outcome: { ok: false } } });
      expect(artifacts.size).toBe(0);
      expect(effects).toHaveLength(0);
      return;
    }
    expect(asked, JSON.stringify(asked)).toMatchObject({
      ok: true,
      result: {
        kind: 'action.execution',
        outcome: { ok: true, result: { kind: 'approval_request_created' } },
      },
    });
    expect(effects).toHaveLength(0);
    const artifactId = [...artifacts.keys()][0];
    if (!artifactId) throw new Error('No approval request was saved');
    if (scenario === 'input_changed') {
    // Home serves a stored Ask whose Action input is not the one this installation signed.
    const stored = artifacts.get(artifactId)!;
    const content = decodePlainArtifactStoredContent(String(stored.body)) as { body: string };
    const body = JSON.parse(content.body) as Record<string, unknown>;
    const request = (body.request ?? body) as Record<string, unknown>;
    request.input = { greeting: 'changed' };
    artifacts.set(artifactId, { ...stored, body: encodePlainArtifactStoredContent({ ...content, body: JSON.stringify(body) }) });
  }
    rootWithdrawn = scenario === 'authorization_withdrawn';
    // The person's Approve reaches this daemon as Home relays it: a present-user
    // `approval.request.decide` root admitted by the installed external Action ingress.
    const target = { kind: 'machine' as const, machineId: 'machine' };
    const decideInput = {
      artifactId,
      decision: 'approve',
      serverIdentityId: homeId,
    };
    const envelope = ExternalActionRequestEnvelopeSchema.parse({
      v: 1,
      requestId: 'decide-greet',
      target,
      input: decideInput,
    });
    const decided = await executeExternalAction({
      ...owner,
      actionId: 'approval.request.decide',
      envelope,
      executionAuthorization:
        ExternalActionExecutionAuthorizationV1Schema.parse({
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
    if (scenario === 'current') {
      expect(decided, JSON.stringify({ decided, stale })).toMatchObject({
        kind: 'response',
        response: { execution: { ok: true } },
      });
      expect(stale).toEqual([]);
      expect(effects).toEqual(['greet']);
      return;
    }
    expect(decided).toMatchObject({
      kind: 'response',
      response: { execution: { ok: false, errorCode: 'approval_stale' } },
    });
    expect(stale).toEqual([
      { code: 'approval_stale', reason: 'credential_changed' },
    ]);
    expect(effects).toHaveLength(0);
  },
);
