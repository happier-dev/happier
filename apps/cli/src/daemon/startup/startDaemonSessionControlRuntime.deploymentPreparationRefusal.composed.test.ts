import axios from 'axios';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { ExternalActionExecutionAuthorizationRequestV1Schema, ExternalActionExecutionAuthorizationV1Schema,
  bindExternalActionExecutionAuthorizationHttpPathV1, bindExternalActionExecutionAuthorizationVerifyHttpPathV1,
  projectExternalActionDeploymentPreparationEnvelopeAdmissionV1,
} from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { ExternalActionHttpErrorSchema } from '@happier-dev/protocol/actions/externalActionHttpError';
import { EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER } from '@happier-dev/protocol/actions';
import type { startDaemonControlServer } from '@/daemon/controlServer';
import { createInstalledProjectAgentDaemonFixture } from '@/daemon/testkit/installedProjectAgentDaemonFixture';
import { writeDaemonSettingsFixture } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { reloadConfiguration } from '@/configuration';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { readCarrierMutation } from '@/api/artifacts/accountArtifactStore.testkit';
import { getActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';

const boundary = vi.hoisted(() => ({ control: null as Parameters<typeof startDaemonControlServer>[0] | null }));
// Only Home HTTP and the private listener are substituted; Session custody,
// issuer mint/binding, signed Machine reads and failure projection stay real.
vi.mock('@/daemon/controlServer', () => ({ startDaemonControlServer: async (input: Parameters<typeof startDaemonControlServer>[0]) => {
  boundary.control = input;
  return { port: 43129, stop: async () => {} };
} }));
vi.mock('undici', async importOriginal => {
  const actual = await importOriginal<typeof import('undici')>();
  return { ...actual, fetch: ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args)) as unknown as typeof actual.fetch };
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); boundary.control = null; });
afterAll(() => pluginReloadController.shutdown());

it.each(['prepare refusal', 'create defaults'] as const)('%s through the ordinary agent Session issuer', async scenario => {
  const home = 'srv_session_prepare_refusal';
  const actionId = scenario === 'prepare refusal' ? 'deployments.publish.prepare' : 'deployments.environments.create';
  const authentication = { kind: 'terminal', tokenEpoch: 0,
    evidence: [{ kind: 'home_method', methodId: 'email_password' }] } as const;
  const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'requester', tokenEpoch: 0,
    provenance: { v: 2, kind: 'terminal', authority: 'account_automation', evidence: authentication.evidence } })).toString('base64url')}.signature`, encryption: null };
  const h = await createInstalledProjectAgentDaemonFixture(() => boundary.control, undefined, true, undefined, undefined, {
    credentials, accountActionCredentials: credentials, externalActionAccountId: 'requester', homeServerIdentityId: home,
    ordinaryAccountSession: true,
    resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: home, machineId: 'machine' }),
    agentIsolation: { read: () => ({ enabled: false, status: { kind: 'disabled' }, workspaceRoots: [] }) },
  });
  const serverId = h.f.bootstrap.attribution.serverId;
  await writeDaemonSettingsFixture(h.f.directory, { activeServerId: serverId,
    servers: { [serverId]: { id: serverId, name: 'Issuer Home', serverUrl: 'https://session-home.test',
      webappUrl: 'https://session-home.test', createdAt: 0, updatedAt: 0, lastUsedAt: 0,
      homeConnectionDescriptorAuthority: 'exact', homeConnectionDescriptor: { v: 1, homeServerIdentityId: home,
        canonicalServerUrl: 'https://session-home.test', revision: 1,
        endpoints: [{ kind: 'https', url: 'https://session-home.test' }] },
    } }, machineIdByServerId: { [serverId]: 'machine' }, lastTokenSubByServerId: { [serverId]: 'requester' },
  });
  reloadConfiguration();
  const installed = await h.machine.resolveInstalledAccountObservationRuntime(h.signal);
  expect(installed?.accountId).toBe('requester');
  expect(await installed?.isCurrent()).toBe(true);
  const homeFetch = globalThis.fetch;
  vi.stubGlobal('fetch', async (...args: Parameters<typeof fetch>) => {
    const path = new URL(String(args[0])).pathname;
    if (path === '/v1/features' || path === '/features') return Response.json({ features: {}, capabilities: {
      serverIdentity: { serverIdentityId: home } } });
    return homeFetch(...args);
  });
  const homeWrite = vi.mocked(axios.post).getMockImplementation()!;
  let minted = false;
  let accountSettingsWrites = 0;
  const documents = new Map<string, Record<string, unknown>>();
  vi.mocked(axios.post).mockImplementation(async (...args) => {
    const path = new URL(String(args[0])).pathname;
    if (path === '/v1/account/settings' || path === '/v2/account/settings') accountSettingsWrites++;
    if (scenario === 'create defaults' && path === '/v1/artifacts') {
      const mutation = readCarrierMutation(args[1]);
      const id = String(mutation.id);
      documents.set(id, { ...mutation, id, ownerAccountId: 'requester', access: 'owner', publicAudience: 'none',
        encryptionMode: 'plain', headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 });
      return { status: 200, data: { id, success: true, headerVersion: 1, bodyVersion: 1 } };
    }
    if (path === bindExternalActionExecutionAuthorizationHttpPathV1(actionId)) {
      const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(args[1]);
      minted = true;
      return { status: 200, data: ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'synthetic-prepare-proof', binding: {
        accountId: 'requester', authentication, serverIdentityId: home, machineId: request.envelope.target.kind === 'machine'
          ? request.envelope.target.machineId : 'machine', custodianAccountId: 'requester',
        installationId: h.f.installation.installationId, admittedMachineRole: 'manage', accountEncryptionMode: 'plain',
        actionId, requestId: request.envelope.requestId, target: request.envelope.target,
        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope),
        sessionActionOrigin: request.sessionActionOrigin, sessionActionSource: request.sessionActionSource,
        deploymentPreparationAdmission: projectExternalActionDeploymentPreparationEnvelopeAdmissionV1({ actionId, envelope: request.envelope }),
      } }) };
    }
    if (path === bindExternalActionExecutionAuthorizationVerifyHttpPathV1(actionId)) return { status: 200, data: { ok: true } };
    return homeWrite(...args);
  });
  const homeRead = vi.mocked(axios.get).getMockImplementation()!;
  let refusedMachineRead = false;
  let requesterSettingsReads = 0;
  const details = { requiredFact: 'deployment_preparation', remedy: 'Update the Home server and this Machine, then retry the action' };
  const homeRefusal = ExternalActionHttpErrorSchema.parse({ error: 'invalid_token', authorizationRefusal: 'deployment_preparation', details });
  vi.mocked(axios.get).mockImplementation(async (...args) => {
    const path = new URL(String(args[0])).pathname;
    if (scenario === 'create defaults' && path === '/v2/account/settings') {
      expect(args[1]?.headers?.Authorization).toBe(`Bearer ${credentials.token}`);
      requesterSettingsReads++;
      return { status: 200, data: { content: { t: 'plain', v: { deploymentDefaultsV1: {
        controllerMachineId: 'machine', buildMachineId: 'machine', retainPreviousDeployments: 7,
      } } }, version: 2 } };
    }
    if (path.startsWith('/v1/artifacts/') && documents.has(path.split('/').at(-1)!))
      return { status: 200, data: documents.get(path.split('/').at(-1)!) };
    if (new URL(String(args[0])).pathname === '/v1/machines/store-target'
      && Object.keys(args[1]?.headers ?? {}).some(key => key.toLowerCase() === EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER)) {
      refusedMachineRead = true;
      throw Object.assign(new Error('synthetic-secret-must-not-leak'), { response: { status: 401, data: homeRefusal },
        config: { headers: { Authorization: 'synthetic-credential-must-not-leak' } } });
    }
    return homeRead(...args);
  });
  const activeSettings = getActiveAccountSettingsSnapshot();
  const response = await h.dispatch({ kind: 'action.execute', surface: 'agent', actionId,
    requestId: h.operationBase().requestId,
    input: scenario !== 'prepare refusal' ? { serverId: home, requestKey: 'create-settings', name: 'Create settings', mode: 'preview',
      newProject: { name: 'Create settings', requestKey: 'create-settings', owner: { kind: 'account', accountId: 'requester' } },
      protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
      definition: { from: 'image', image: 'nginx:alpine', port: 80 },
    } : { serverId: home, machineId: 'store-target', installationId: h.f.installation.installationId,
      newProject: { name: 'Store prepare', requestKey: 'store-prepare', owner: { kind: 'account', accountId: 'requester' } },
      templateRef: { sourceId: 'builtin:dokploy-templates', itemId: 'changedetection', version: `sha256:${'a'.repeat(64)}`,
        ref: { kind: 'content', digest: `sha256:${'a'.repeat(64)}` } },
      explicit: { buildMachineId: 'store-target', controllerMachineId: 'store-target', retainPreviousDeployments: 0 } },
    witness: { turnId: 'prepare-turn', inputId: 'prepare-input', userMessageSeq: 1, userMessageSeqs: [1], workDepth: 0,
      agentStartCaller: { kind: 'session', sessionId: h.sessionId, starterDepth: 0, turnDepth: 0 }, callerPermissionMode: 'default' },
  });
  expect(minted).toBe(true);
  if (scenario === 'create defaults') {
    expect(response, JSON.stringify(response)).toMatchObject({ ok: true, result: { kind: 'action.execution', outcome: {
      ok: true, result: { kind: 'preview', input: { controllerMachineId: 'machine', buildMachineId: 'machine' },
        review: { creationDefaults: { values: { retainPreviousDeployments: 7 }, sources: {
          controllerMachineId: 'account', buildMachineId: 'account', retainPreviousDeployments: 'account',
        } } } },
    } } });
    expect(requesterSettingsReads).toBe(1);
    expect(accountSettingsWrites).toBe(0);
    expect(getActiveAccountSettingsSnapshot()).toBe(activeSettings);
    expect(h.nativeEffects()).toBe(0);
    return;
  }
  expect(refusedMachineRead, JSON.stringify(response)).toBe(true);
  expect(response, JSON.stringify(response)).toMatchObject({ ok: true, result: { kind: 'action.execution', outcome: {
    ok: false, errorCode: 'action_forbidden', details,
    failureCause: { phase: 'home.authorization.deployment_preparation', httpStatus: 401 },
  } } });
  expect(JSON.stringify(response)).not.toContain('synthetic-secret-must-not-leak');
  expect(JSON.stringify(response)).not.toContain('synthetic-credential-must-not-leak');
  expect(h.nativeEffects()).toBe(0);
}, 120_000);
