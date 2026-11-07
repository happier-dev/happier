import axios from 'axios';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { ExternalActionExecutionAuthorizationRequestV1Schema, ExternalActionExecutionAuthorizationV1Schema,
  bindExternalActionExecutionAuthorizationHttpPathV1, bindExternalActionExecutionAuthorizationVerifyHttpPathV1,
} from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import type { startDaemonControlServer } from '@/daemon/controlServer';
import { createInstalledProjectAgentDaemonFixture } from '@/daemon/testkit/installedProjectAgentDaemonFixture';
import { writeDaemonSettingsFixture } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { reloadConfiguration } from '@/configuration';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { AgentRuntimeDaemonServiceRequestV1Schema } from '@/agent/runtime/session/process/agentRuntimeDaemonServiceProtocol';
import { createAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { approvalArtifactBodyMatchesHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { BotTemplateDraftV1Schema, projectBotTemplateArtifactHeaderV1 } from '@happier-dev/protocol/bots/templates/botTemplateV1';
import { normalizeActionsSettingsV1, setActionApprovalOverride } from '@happier-dev/protocol/actions/actionSettings';
import { bootstrapAccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';

const boundary = vi.hoisted(() => ({ control: null as Parameters<typeof startDaemonControlServer>[0] | null }));
// Only the private listener and Home HTTP are replaced; Session dispatch,
// credential custody, signing, binding validation and Action policy stay real.
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

it.each([
  { actionId: 'template.draft', matchingEvidence: true },
  { actionId: 'artifact.delete', matchingEvidence: true },
  { actionId: 'template.draft', matchingEvidence: false },
  { actionId: 'artifact.delete', matchingEvidence: false },
] as const)('binds ordinary agent Session credential evidence for $actionId (matching=$matchingEvidence)', async ({ actionId, matchingEvidence }) => {
  const home = 'srv_session_issuer_evidence';
  const evidence = [{ kind: 'home_method' as const, methodId: 'email_password' }];
  const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'requester', tokenEpoch: 0,
    provenance: { v: 2, kind: 'terminal', authority: 'account_automation', evidence } })).toString('base64url')}.signature`, encryption: null };
  const h = await createInstalledProjectAgentDaemonFixture(() => boundary.control, undefined, true, undefined, undefined, {
    credentials, accountActionCredentials: credentials, externalActionAccountId: 'requester', homeServerIdentityId: home,
    ordinaryAccountSession: true,
    accountSettings: { actionsSettingsV1: setActionApprovalOverride({ settings: normalizeActionsSettingsV1({}),
      actionId, surface: 'agent', approvalRequired: true }) },
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
  // Ordinary Main Sessions consume the daemon's active Account policy;
  // the fixture's separately admitted invocation provider is not that source.
  const policy = await bootstrapAccountSettingsContext({ credentials, mode: 'blocking', refresh: 'force',
    publication: 'active', expectedAccountEncryptionMode: 'plain' });
  expect(policy.settings.actionsSettingsV1.actions[actionId]?.approvalRequiredSurfaces).toContain('agent');
  const installed = await h.machine.resolveInstalledAccountObservationRuntime(h.signal);
  expect(installed?.accountId).toBe('requester');
  expect(await installed?.isCurrent()).toBe(true);
  const homeWrite = vi.mocked(axios.post).getMockImplementation()!;
  const homeRead = vi.mocked(axios.get).getMockImplementation()!;
  const draft = BotTemplateDraftV1Schema.parse({ v: 1, state: 'draft',
    sourceSessionRef: { serverId: home, sessionId: h.sessionId }, releaseArtifactId: '7e23f798-230a-42f3-931f-e38b20736333',
    content: { v: 1, identity: { name: 'Own draft', description: '' }, instructions: { markdown: '' },
      memoryRules: [], skills: [], needs: { software: [], connectedAccounts: [], mcpServers: [] } },
    candidates: { memoryRules: [], skills: [] } });
  const rows = new Map<string, Record<string, unknown>>();
  rows.set('own-draft', { id: 'own-draft', ownerAccountId: 'requester', access: 'owner', encryptionMode: 'plain',
    publicAudience: 'none', headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1,
    header: { t: 'plain', v: projectBotTemplateArtifactHeaderV1(draft) }, body: { t: 'plain', v: JSON.stringify(draft) } });
  let publish!: (id: string) => void;
  const published = new Promise<string>(resolve => { publish = resolve; });
  vi.mocked(axios.get).mockImplementation(async (...args) => {
    const path = new URL(String(args[0])).pathname;
    if (path.startsWith('/v1/artifacts/')) {
      const row = rows.get(path.split('/').at(-1)!);
      return { status: row ? 200 : 404, data: row ?? null };
    }
    return homeRead(...args);
  });
  const homeFetch = globalThis.fetch;
  vi.stubGlobal('fetch', async (...args: Parameters<typeof fetch>) => {
    const path = new URL(String(args[0])).pathname;
    if (path === '/v1/features' || path === '/features') return Response.json({ features: {}, capabilities: {
      serverIdentity: { serverIdentityId: home } } });
    return homeFetch(...args);
  });
  let minted = false;
  let verified = false;
  vi.mocked(axios.post).mockImplementation(async (...args) => {
    const path = new URL(String(args[0])).pathname;
    if (path === bindExternalActionExecutionAuthorizationHttpPathV1(actionId)) {
      minted = true;
      const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(args[1]);
      expect(request.sessionActionOrigin?.caller).toMatchObject({ kind: 'session', sessionId: h.sessionId });
      return { status: 200, data: ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'issuer-evidence-proof', binding: {
        accountId: 'requester', authentication: { kind: 'terminal', tokenEpoch: 0,
          evidence: matchingEvidence ? evidence : [{ kind: 'home_method', methodId: 'webauthn' }] }, serverIdentityId: home,
        machineId: 'machine', custodianAccountId: 'requester', installationId: h.f.installation.installationId,
        actionId, requestId: request.envelope.requestId, target: request.envelope.target,
        accountEncryptionMode: 'plain', requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope),
        sessionActionOrigin: request.sessionActionOrigin, sessionActionSource: request.sessionActionSource,
      } }) };
    }
    if (path === bindExternalActionExecutionAuthorizationVerifyHttpPathV1(actionId)) {
      verified = true;
      return { status: 200, data: { ok: true } };
    }
    if (path === '/v1/artifacts') {
      const body: unknown = args[1];
      if (!body || typeof body !== 'object') throw new Error('Missing Artifact body');
      const id = String(Reflect.get(body, 'id'));
      rows.set(id, { ...body, ownerAccountId: 'requester', access: 'owner', encryptionMode: 'plain',
        publicAudience: 'none', headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 });
      publish(id);
      return { status: 200, data: { id, headerVersion: 1, bodyVersion: 1 } };
    }
    return homeWrite(...args);
  });
  const input = actionId === 'template.draft' ? {
    sourceSessionRef: { serverId: home, sessionId: h.sessionId },
    content: draft.content,
  } : { artifactId: 'own-draft', expectedRevision: { headerVersion: 1, bodyVersion: 1 } };
  const operation = { kind: 'action.execute', surface: 'agent', actionId,
    requestId: h.operationBase().requestId, input,
    witness: { turnId: 'issuer-turn', inputId: 'issuer-input', userMessageSeq: 1, userMessageSeqs: [1], workDepth: 0,
      agentStartCaller: { kind: 'session', sessionId: h.sessionId, starterDepth: 0, turnDepth: 0 }, callerPermissionMode: 'default' },
  } as const;
  const lifetime = new AbortController();
  const services = boundary.control!.agentRuntimeDaemonServices!;
  const pending = services.dispatch(AgentRuntimeDaemonServiceRequestV1Schema.parse({ v: 1,
    context: { token: 'a'.repeat(43), sessionId: h.sessionId }, operation }), {
    sessionId: h.sessionId, runner: h.runner, retainedAgent: h.retainedAgent, trackedSession: h.tracked,
    invocationContext: h.tracked.runnerAgentInvocationContext!, isCurrent: async () => true, signal: lifetime.signal,
  });
  const issuerRefusal = { ok: true, result: { kind: 'action.execution', outcome: {
    ok: false, details: { reason: 'external_authorization_refused' },
  } } };
  try {
    if (matchingEvidence) {
      const first = await Promise.race([published.then(id => ({ id })), pending.then(response => ({ response }))]);
      expect(first).toHaveProperty('id');
      if (!('id' in first)) throw new Error('Action settled before publishing review');
      const artifact = await runWithServerHttpBaseUrl('https://session-home.test', () =>
        createAccountArtifactStore({ credentials, getAccountEncryptionMode: async () => 'plain' }).read(first.id));
      expect(artifact).not.toBeNull();
      const card = artifact && approvalArtifactBodyMatchesHeaderV1(artifact.header, artifact.body);
      expect(card?.request).toMatchObject({ status: 'open', executionOriginV1: { surface: 'agent', authority: 'account_automation' } });
      expect(verified).toBe(true);
    } else {
      expect(await pending).toMatchObject(issuerRefusal);
      expect(verified).toBe(false);
    }
    expect(minted).toBe(true);
    expect(h.nativeEffects()).toBe(0);
  } finally {
    lifetime.abort();
    await pending.catch(() => undefined);
  }
}, 120_000);
