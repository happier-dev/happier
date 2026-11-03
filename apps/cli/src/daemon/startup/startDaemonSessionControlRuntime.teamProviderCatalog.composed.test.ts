import axios from 'axios';
import { createServer, request as requestHttp } from 'node:http';
import { join, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import tweetnacl from 'tweetnacl';
import { MACHINE_CONTROL_TIMEOUT_MS } from '@happier-dev/iroh-native';
import { MACHINE_HTTP_LOCAL_CAPABILITY_HEADER } from '@happier-dev/iroh-native/node';
import { createProviderBrokerRouteGrantSigningInputV1 } from '@happier-dev/protocol/providers/brokerRouteGrantV1';
import { DIRECT_ROUTE_GRANT_TTL_MS } from '@happier-dev/protocol/machines/peer/mediation/directRouteGrantCachePolicyV1';
import { afterEach, expect, it, onTestFailed, onTestFinished, vi } from 'vitest';
import { DEFAULT_PROVIDER_SETTINGS_V1, splitProviderSettingsV1 } from '@happier-dev/protocol';
import { ProviderModelBindingSourceV1Schema } from '@happier-dev/protocol/providers/binding-compatibility';
import type { TeamCredentialProviderModelCatalogEntryV1 } from '@happier-dev/protocol/teams';
import type { startDaemonControlServer } from '@/daemon/controlServer';
import { createInstalledProjectAgentDaemonFixture } from '@/daemon/testkit/installedProjectAgentDaemonFixture';
import { openSessionTeamCredentialProviderBinding } from '@/providers/broker/sessionTeamCredentialProviderBinding';
import { resolveTeamCredentialModelCompatibility } from '@/providers/broker/teamCredentialModelCompatibility';
import { PROVIDER_BROKER_APPLICATION_ERROR_CODE_HEADER, PROVIDER_BROKER_ENDPOINT_PATH_HEADER, PROVIDER_BROKER_PRIVATE_ENDPOINT_PATH } from '@/providers/broker/providerBrokerPrivateProtocol';
import { getActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { emptyAccountSettingsHistoryCaptureResponse } from '@/settings/accountSettings/emptyAccountSettingsHistoryCapture.testkit';
// Parse the real broker producer with the exact plugin-open consumer, not a
// test copy of the Codex engine-config schema. No production private import.
import { parseCodexProviderBindingEngineConfigV1 } from '../../../../../packages/plugins/codex/src/agent/providerBinding/runtimeConfig';
import { configuration } from '@/configuration';
import { createAgentRuntimeDaemonServiceAuthorityPath, publishAgentRuntimeDaemonServiceAuthority,
  readCurrentRunnerAgentRuntimeDaemonServiceAuthority, removeAgentRuntimeDaemonServiceAuthorityIfOwned } from '@/daemon/agentRuntime/sessionBridgeAuthorization';
import { openCurrentRunnerTeamCredentialProviderBinding, readCurrentRunnerTeamCredentialBrokerDenial } from '@/agent/runtime/session/process/agentRuntimeDaemonServiceAuthorityClient';
import { createSessionTurnLifecycle } from '@/agent/runtime/session/turn/lifecycle';
import type { SessionTurnMutationV1 } from '@happier-dev/protocol';
import { presentSessionTeamCredentialDenial } from '../../../../ui/sources/components/sessions/presentation/sessionTeamCredentialDenialPresentation';
import { classifyPrimarySessionRuntimeIssue, readSessionPreparationFailureDiagnostic } from '@/agent/runtime/session/errors/classifyPrimarySessionRuntimeIssue';
import { AGENT_RUNTIME_DAEMON_SERVICES_PATH } from '@/agent/runtime/session/process/agentRuntimeDaemonServiceProtocol';
import { logger } from '@/ui/logger';
import { createDaemonMachineIrohRuntime, type DaemonMachineIrohRuntime } from '@/daemon/peer/iroh/daemonMachineIrohRuntime';
import { createProviderBrokerMachineCarrierTunnelOpen } from '@/daemon/peer/iroh/providerBrokerMachineCarrierTunnelOpen';
import { startPeerMediationLoopbackServer } from '@/daemon/peer/mediation/loopback/server';
import { openDaemonSessionTeamCredentialProviderBinding } from '@/daemon/providers/sessionTeamCredentialProviderBindingComposition';
import { TeamCredentialResourceCatalogEntryV1Schema } from '@happier-dev/protocol/teams/credentials/resourceV1';
import { PROVIDER_BROKER_OPEN_HTTP_PATH_V1 } from '@happier-dev/protocol/providers/brokerRouteGrantV1';
import { ProviderBrokerOpenRequestV1Schema, type ProviderBrokerOpenRequestV1 } from '@happier-dev/protocol/providers/brokerRouteGrantV1';
import { TEAM_CREDENTIAL_ACTION_PATHS_V1 } from '@happier-dev/protocol/teams/credentials/actionsV1';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { SessionMetadataTuplePatchV1Schema } from '@happier-dev/protocol';
import * as processIdentity from '@/daemon/processIdentity';
import { hashProcessCommand, writeSessionMarker } from '@/daemon/sessionRegistry';
import { createRunnerAgentSessionRuntimeSource } from '@/agent/runtime/session/process/runnerAgentSessionRuntimeSource';
import { resolveCliEngineRegistry } from '@/agent/runtime/registry/engineRegistry/registry';
import { resolveRunnerMcpServers } from '@/mcp/runtime/resolveRunnerMcpServers';
import { applyRunnerMcpSessionContext } from '@/mcp/runtime/applyRunnerMcpSessionContext';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { ensureSkillSessionDirHttp } from '@/daemon/controlClient';
import { computePromptBundleDigestV1 } from '@happier-dev/protocol/prompts/library/promptLibraryDigests';
import { createSessionBrokerApplicationEvidence } from '@/providers/broker/sessionBrokerApplicationEvidence';

await vi.hoisted(async () => {
  const path = new URL('../../../../ui/sources/dev/vitestRnShim.ts', import.meta.url).href;
  const { installVitestRnShim } = await import(path);
  installVitestRnShim();
});

// This composed CLI suite consumes the real UI denial presenter. Its native
// stylesheet boundary uses the same theme fixture as the owning UI testkit.
vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('../../../../ui/sources/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});
vi.mock('expo-updates', async () => {
  const { createExpoUpdatesMock } = await import('../../../../ui/sources/dev/testkit/mocks/expoUpdates');
  return createExpoUpdatesMock();
});
vi.mock('@shopify/react-native-skia', async () => {
  const { createReactNativeSkiaMock } = await import('../../../../ui/sources/dev/testkit/mocks/reactNativeSkia');
  return createReactNativeSkiaMock();
});
vi.mock('expo-file-system', async () => {
  const { createExpoFileSystemFileMock } = await import('../../../../ui/sources/dev/testkit/mocks/expoFileSystem');
  return createExpoFileSystemFileMock().module;
});

const nativeFetch = fetch;
const boundary = vi.hoisted(() => ({ control: null as Parameters<typeof startDaemonControlServer>[0] | null, port: 0,
  responseStatus: 0, responseBody: null as unknown }));
// Keep the real control app/dispatcher; only its OS listener uses an ephemeral port.
vi.mock('@/daemon/controlServer', async importOriginal => {
  const actual = await importOriginal<typeof import('@/daemon/controlServer')>();
  return { ...actual, startDaemonControlServer: async (input: Parameters<typeof startDaemonControlServer>[0]) => {
    boundary.control = input;
    const app = actual.createDaemonControlApp(input);
    app.addHook('onSend', async (request, reply, payload) => {
      if (request.url === AGENT_RUNTIME_DAEMON_SERVICES_PATH && typeof payload === 'string') {
        boundary.responseStatus = reply.statusCode;
        boundary.responseBody = JSON.parse(payload);
      }
      return payload;
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('Missing private listener');
    boundary.port = address.port;
    return { port: address.port, stop: () => app.close() };
  } };
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); resetActiveAccountSettingsSnapshotForTests(); boundary.control = null; });

it.each(['direct', 'wrapped'] as const)('prepares grantee host input through readiness-issued authority and diagnoses a mis-bound Home (%s)', async mode => {
  const debug = vi.spyOn(logger, 'debug');
  const command = `${process.execPath} ${resolve(__dirname, '../../..', 'src/index.ts')} codex --started-by daemon`;
  // Install the OS boundary before production readiness captures its adapter.
  vi.spyOn(processIdentity, 'readProcessIdentityByPid').mockResolvedValue({ pid: process.pid,
    processStartTimeMs: 1, command });
  const h = await createInstalledProjectAgentDaemonFixture(() => boundary.control, 'codex', false, undefined, undefined,
    { machineAccess: { custodianAccountId: 'custodian', role: 'use' } });
  const requester = h.requester;
  expect(requester.bootstrap.savedSecretOperationContext.machineAdmission).toMatchObject({
    actorAccountId: 'requester', custodianAccountId: 'custodian',
  });
  expect(requester.bootstrap.allowNativeAccountCredentials).toBe(false);
  expect(vi.mocked(axios.post)).toHaveBeenCalledWith('https://session-home.test/v1/machines/machine/admission/verify',
    expect.objectContaining({ context: expect.objectContaining({ actorAccountId: 'requester', custodianAccountId: 'custodian', role: 'use' }) }),
    expect.anything());
  h.tracked.spawnOptions = { ...h.tracked.spawnOptions, existingSessionId: h.sessionId, teamCredentialBindings: [{ v: 1, slot: { kind: 'provider_model' },
    teamId: 'team', resourceId: 'resource', expectedResourceRevision: 2, deliveryMode: 'brokered' }] };
  h.runner.processCommandHash = hashProcessCommand(command);
  h.tracked.processCommandHash = h.runner.processCommandHash;
  if (mode === 'wrapped') {
    // The launcher keeps exit custody; only the reported runner receives daemon authority.
    h.pidToTrackedSession.clear();
    h.tracked.pid = 999_123_455;
    h.tracked.processStartTimeMs = 0;
    h.tracked.processCommandHash = hashProcessCommand('fixture-wrapper');
    h.tracked.runnerProcessIdentity = { ...h.runner, processCommand: command };
    h.pidToTrackedSession.set(h.tracked.pid, h.tracked);
  }
  const metadata = createTestMetadata({ hostPid: process.pid, hostProcessStartTimeMs: h.runner.processStartTimeMs,
    path: h.cwd, machineId: 'machine', startedBy: 'daemon', happyHomeDir: h.f.directory });
  const path = await createAgentRuntimeDaemonServiceAuthorityPath({ happyHomeDir: h.f.directory,
    publicReleaseRing: configuration.publicReleaseRing });
  h.tracked.agentRuntimeDaemonServiceAuthorityFilePath = path;
  h.pidToAwaiter.set(h.tracked.pid, () => {});
  await writeSessionMarker({ pid: process.pid, happySessionId: h.sessionId, startedBy: 'daemon', cwd: h.cwd,
    processStartTimeMs: h.runner.processStartTimeMs, processCommandHash: h.runner.processCommandHash, processCommand: command,
    agentRuntimeDaemonServiceAuthorityFilePath: path });
  // The real readiness handler publishes authority before acknowledging the runner.
  const ready = await nativeFetch(`http://127.0.0.1:${boundary.port}/session-started`, { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-happier-daemon-token': boundary.control!.controlToken },
    body: JSON.stringify({ sessionId: h.sessionId, metadata }) });
  const readinessErrors = debug.mock.calls.filter(([label]) => String(label).startsWith('[DAEMON RUN] Canonical Session startup readiness failed'))
    .map(([label, error]) => `${label}: ${error instanceof Error ? error.message : ''}`);
  expect(ready.status, `${await ready.text()}: ${readinessErrors.join('; ')}`).toBe(200);
  expect(h.tracked.agentRuntimeDaemonServiceCapabilityHash).toBeTruthy();
  const issued = await readCurrentRunnerAgentRuntimeDaemonServiceAuthority({ happyHomeDir: h.f.directory,
    publicReleaseRing: configuration.publicReleaseRing, path, expectedSessionId: h.sessionId });
  if (!issued) throw new Error('Missing readiness authority');
  const expectedAuthority = { happyHomeDir: h.f.directory, publicReleaseRing: configuration.publicReleaseRing,
    path, sessionId: h.sessionId, runner: issued.runner, retainedAgent: issued.retainedAgent };
  expect(requester.bootstrap.attribution.accountId).toBe('requester');
  expect(requester.bootstrap.credentials.token).not.toBe('custodian-token');
  const homeFetch = globalThis.fetch;
  vi.stubGlobal('fetch', (url: Parameters<typeof fetch>[0], init?: RequestInit) =>
    new URL(String(url)).hostname === '127.0.0.1' ? nativeFetch(url, init) : homeFetch(url, init));
  const source = await createRunnerAgentSessionRuntimeSource({ happyHomeDir: h.f.directory,
    publicReleaseRing: configuration.publicReleaseRing, authorityFilePath: path, expectedSessionId: h.sessionId,
    occurrenceId: 'qb174-runner' });
  if (!source) throw new Error('Readiness did not issue consumable runner authority');
  onTestFinished(() => source.retire?.());
  const readLog = vi.spyOn(logger, 'infoFile').mockImplementation(() => {});
  const readRequests = vi.spyOn(globalThis, 'fetch');
  try {
    await expect(source.daemonTurnContributionsBridge!.readTeamCredentialDenial!({
      sessionId: h.sessionId, turnId: 'refusal-read-turn',
    })).resolves.toBeNull();
    expect(readRequests).not.toHaveBeenCalled();
    h.tracked.activeTurnId = 'refusal-read-turn';
    await expect(readCurrentRunnerTeamCredentialBrokerDenial({ authority: expectedAuthority,
      turnId: 'refusal-read-turn' })).resolves.toBeNull();
    await expect(readCurrentRunnerTeamCredentialBrokerDenial({ authority: expectedAuthority,
      turnId: 'previous-turn' })).resolves.toBeNull();
    let evidenceCurrent = true;
    h.tracked.teamCredentialBrokerEvidence = createSessionBrokerApplicationEvidence({
      sessionId: h.sessionId, pid: issued.runner.pid, processStartTimeMs: issued.runner.processStartTimeMs,
      readActiveTurnId: () => h.tracked.activeTurnId ?? null, isCurrent: () => evidenceCurrent,
    });
    const denial = { v: 1, resourceId: 'PRIVATE_RESOURCE', reasonCode: 'resource_forbidden' } as const;
    h.tracked.teamCredentialBrokerEvidence.beginRequest()?.(denial);
    await expect(readCurrentRunnerTeamCredentialBrokerDenial({ authority: expectedAuthority,
      turnId: 'refusal-read-turn' })).resolves.toEqual(denial);
    // A captured refusal belongs to its exact turn even after lifecycle tracking
    // clears or advances. The evidence owner still rejects a different turn.
    delete h.tracked.activeTurnId;
    await expect(readCurrentRunnerTeamCredentialBrokerDenial({ authority: expectedAuthority,
      turnId: 'refusal-read-turn' })).resolves.toEqual(denial);
    h.tracked.activeTurnId = 'next-turn';
    await expect(readCurrentRunnerTeamCredentialBrokerDenial({ authority: expectedAuthority,
      turnId: 'refusal-read-turn' })).resolves.toEqual(denial);
    await expect(readCurrentRunnerTeamCredentialBrokerDenial({ authority: expectedAuthority,
      turnId: 'next-turn' })).resolves.toBeNull();
    evidenceCurrent = false;
    await expect(readCurrentRunnerTeamCredentialBrokerDenial({ authority: expectedAuthority,
      turnId: 'refusal-read-turn' })).resolves.toBeNull();
    // One private RPC per demanded supported read; unsupported runners stay local.
    expect(readRequests).toHaveBeenCalledTimes(7);
    const context = { sessionId: h.sessionId, pid: issued.runner.pid, processStartTimeMs: issued.runner.processStartTimeMs };
    expect(readLog.mock.calls.filter(([label, data]) => label === '[provider-broker-application]'
      && data && typeof data === 'object' && 'stage' in data && data.stage === 'evidence_read').map(([, data]) => data)).toEqual([
      { ...context, stage: 'evidence_read', turnId: 'refusal-read-turn', outcome: 'miss', reason: 'no_evidence' },
      { ...context, stage: 'evidence_read', turnId: 'previous-turn', outcome: 'miss', reason: 'no_evidence' },
      { ...context, stage: 'evidence_read', turnId: 'refusal-read-turn', outcome: 'hit' },
      { ...context, stage: 'evidence_read', turnId: 'refusal-read-turn', outcome: 'hit' },
      { ...context, stage: 'evidence_read', turnId: 'refusal-read-turn', outcome: 'hit' },
      { ...context, stage: 'evidence_read', turnId: 'next-turn', outcome: 'miss', reason: 'turn_mismatch' },
      { ...context, stage: 'evidence_read', turnId: 'refusal-read-turn', outcome: 'miss', reason: 'pid_mismatch' },
    ]);
    expect(readLog.mock.calls.filter(([label, data]) => label === '[provider-broker-application]'
      && data && typeof data === 'object' && 'stage' in data && data.stage === 'runner-refusal-read').map(([, data]) => data)).toContainEqual({
        ...context, stage: 'runner-refusal-read', turnId: 'refusal-read-turn', outcome: 'miss', reason: 'unsupported',
      });
  } finally {
    delete h.tracked.activeTurnId;
    delete h.tracked.teamCredentialBrokerEvidence;
    readRequests.mockRestore();
    readLog.mockRestore();
  }
  const engines = await resolveCliEngineRegistry({ happyHomeDir: h.f.directory, backendId: 'codex',
    requireRunnerAgentSessionRuntimeSource: true, runnerAgentSessionRuntimeSource: source });
  const resolution = await engines.resolveForBackendId('codex');
  if (!resolution) throw new Error('Missing admitted Codex engine');
  const plan = await resolution.engineAdapter.runtimeCore.createSessionRuntime({ credentials: requester.bootstrap.credentials,
    directory: h.cwd, backendTarget: { kind: 'backend', backendId: 'codex' } });
  const bridge = plan.deps?.sessionLoopLifecycleDeps?.daemonTurnContributionsBridge;
  const snapshot = requester.readAccountSettingsSnapshot();
  if (!snapshot) throw new Error('Missing captured requester settings');
  const session = applyRunnerMcpSessionContext({ sessionId: h.sessionId,
    getServerBinding: () => ({ serverId: 'session-home', serverUrl: requester.bootstrap.serverHttpBaseUrl }),
    rpcHandlerManager: new RpcHandlerManager({ scopePrefix: h.sessionId, encryptionMode: 'plain' }), updateMetadata() {},
    enqueueSessionEventCommitted: async () => ({ persisted: true, delivered: true }),
  }, { getPluginMcpPort: () => bridge?.pluginMcp ?? null });
  boundary.responseBody = null;
  const prepared = await resolveRunnerMcpServers({ session, credentials: requester.bootstrap.credentials,
    operationContext: requester.bootstrap.savedSecretOperationContext,
    accountSettings: snapshot.settings, accountSettingsSnapshot: { ...snapshot, mcpServerCatalog: { status: 'ready',
      authority: 'active', catalog: { v: 1, servers: [], bindings: [] }, revision: 1, diagnostics: [] } },
    machineId: 'machine', directory: h.cwd, agentId: 'codex', agentAcceptsUserMcp: true,
    includeHappierMcpServer: false, sessionMetadata: metadata });
  onTestFinished(() => prepared.happierMcpServer.stop());
  expect(prepared.mcpServers).toEqual({});
  // An empty result alone would also pass if engine composition dropped the port.
  // Require the real daemon producer's strict response through the runner consumer.
  expect(boundary.responseBody).toMatchObject({ ok: true,
    result: { kind: 'mcp.plugin.materialized', servers: [] } });
  // Materialize through the same real authenticated control app used in host input setup.
  const files = [{ path: 'SKILL.md', contentKind: 'utf8' as const, contentBase64: Buffer.from('---\nname: sample\ndescription: Test\n---\nSkill body').toString('base64') }];
  const skill = await ensureSkillSessionDirHttp({ ownerKey: h.sessionId, items: [{ skillId: 'sample', name: 'sample',
    digest: computePromptBundleDigestV1({ v: 1, createdAtMs: 1, updatedAtMs: 1, entries: files }), files }], nativeDisables: [] },
    { target: { pid: process.pid, httpPort: boundary.port, controlToken: boundary.control!.controlToken } },
    { pid: process.pid, metadata });
  expect(await readFile(join(skill.skillsRoot, 'sample', 'SKILL.md'), 'utf8')).toContain('Skill body');
  // A wrong Home must remain refused, with one closed diagnostic and no transport effect.
  const log = vi.spyOn(logger, 'infoFile').mockImplementation(() => {});
  const requests = vi.spyOn(globalThis, 'fetch');
  const wrongHome = join(h.f.directory, 'different-home');
  await openCurrentRunnerTeamCredentialProviderBinding({ authority: { ...expectedAuthority, happyHomeDir: wrongHome },
    operation: { kind: 'provider_broker.binding.open',
      resourceId: 'resource', expectedResourceRevision: 2, agentTargetKey: 'agent:codex', modelId: 'model' } })
    .then(() => { throw new Error('Wrong Home was admitted'); }, error => expect(error).toMatchObject({
      code: 'native_agent_privileged_effect_authority_unavailable' }));
  expect(requests).not.toHaveBeenCalled();
  expect(log).toHaveBeenCalledWith('[AgentRuntime] Daemon service authority refused', {
    sessionId: h.sessionId, checkpoint: 'authority_read', code: 'native_agent_privileged_effect_authority_unavailable',
  });
  expect(log.mock.calls.filter(([label]) => label === '[AgentRuntime] Daemon service authority refused')).toHaveLength(1);
  h.tracked.agentRuntimeRunnerRestartDisposition = 'runner_authority_unavailable';
  await openCurrentRunnerTeamCredentialProviderBinding({ authority: expectedAuthority,
    operation: { kind: 'provider_broker.binding.open', resourceId: 'resource', expectedResourceRevision: 2,
      agentTargetKey: 'agent:codex', modelId: 'model' } }).then(() => { throw new Error('Retired authority was admitted'); },
      error => expect(error).toMatchObject({ code: 'native_agent_privileged_effect_authority_unavailable' }));
  delete h.tracked.agentRuntimeRunnerRestartDisposition;
  expect(log).toHaveBeenCalledWith('[AgentRuntime] Daemon service authority refused', {
    sessionId: h.sessionId, checkpoint: 'daemon_response', operation: 'provider_broker.binding.open',
    httpStatus: 403, code: 'agent_runtime_daemon_service_forbidden',
  });
  const diagnostics = log.mock.calls.filter(([label]) => label === '[AgentRuntime] Daemon service authority refused');
  expect(diagnostics).toHaveLength(2);
  for (const privateValue of [path, h.f.directory, requester.bootstrap.credentials.token, 'custodian-token']) {
    expect(JSON.stringify(diagnostics)).not.toContain(privateValue);
  }
}, 180_000);

it.each(['before readiness', 'after readiness', 'replacement pid', 'replacement birth', 'wrapped runner', 'retired Account'] as const)(
  'retires only the departed runner metadata through daemon exit tracking (%s)', async scenario => {
    const h = await createInstalledProjectAgentDaemonFixture(() => boundary.control);
    const warnings = vi.spyOn(logger, 'warn');
    const settlementFailures = () => warnings.mock.calls
      .filter(([label]) => label === '[DAEMON RUN] Session exit evidence settlement unavailable; retaining exit custody')
      .map(([, data]) => {
        const error = data && typeof data === 'object' && 'error' in data ? data.error : undefined;
        return error instanceof Error ? { name: error.name, code: Reflect.get(error, 'code'), message: error.message } : null;
      });
    const pid = 999_123_456;
    h.pidToTrackedSession.clear();
    h.tracked.pid = pid;
    h.tracked.sessionRunnerPid = scenario === 'wrapped runner' ? pid + 1 : pid;
    h.tracked.runnerProcessIdentity = { pid: h.tracked.sessionRunnerPid,
      processStartTimeMs: scenario === 'wrapped runner' ? 2 : 1 };
    h.tracked.startedBy = 'terminal';
    h.pidToTrackedSession.set(pid, h.tracked);
    if (scenario === 'after readiness') h.tracked.happySessionMetadataFromLocalWebhook = createTestMetadata({ machineId: 'machine' });
    const metadata = { machineId: 'machine', hostPid: scenario === 'replacement pid' ? pid + 2 : h.tracked.sessionRunnerPid,
      hostProcessStartTimeMs: scenario === 'replacement birth' ? 3 : scenario === 'wrapped runner' ? 2 : 1,
      lifecycleState: 'running', lifecycleStateSince: 10, path: h.cwd };
    const get = vi.mocked(axios.get).getMockImplementation()!;
    vi.mocked(axios.get).mockImplementation(async (url, options) => String(url).endsWith(`/v2/sessions/${h.sessionId}`)
      ? { status: 200, data: { session: createSessionRecordFixture({ id: h.sessionId, encryptionMode: 'plain',
          metadataLayoutVersion: 0, metadataVersion: 1, metadata: JSON.stringify(metadata) }) } }
      : get(url, options));
    const patch = vi.spyOn(axios, 'patch').mockResolvedValue({ status: 200, data: {
      success: true, metadataLayoutVersion: 1, sharedMetadata: { version: 2 }, agentState: { version: 0 },
    } });
    if (scenario === 'retired Account') h.f.retire();
    await h.daemon.onChildExited(pid, { reason: 'process-exited', code: 1, signal: null });
    if (scenario === 'replacement pid' || scenario === 'replacement birth' || scenario === 'retired Account') {
      expect(patch).not.toHaveBeenCalled();
      if (scenario === 'retired Account') expect(h.pidToTrackedSession.get(pid)).toBe(h.tracked);
    } else {
      expect(patch.mock.calls.length, JSON.stringify(settlementFailures())).toBe(1);
      const request = SessionMetadataTuplePatchV1Schema.parse(patch.mock.calls[0]?.[1]);
      expect(request.target.ownerMetadata).toMatchObject({ t: 'plain' });
      if (request.target.ownerMetadata?.t !== 'plain') throw new Error('Expected owner metadata');
      expect(request.target.ownerMetadata.v.workspace?.path).toBe(h.cwd);
      const runtime = request.target.ownerMetadata.v.runtime ?? {};
      expect(runtime).not.toHaveProperty('hostPid');
      expect(runtime).not.toHaveProperty('hostProcessStartTimeMs');
      expect(runtime).not.toHaveProperty('lifecycleState');
      expect(runtime).not.toHaveProperty('lifecycleStateSince');
      await h.daemon.onChildExited(pid, { reason: 'process-exited', code: 1, signal: null });
      expect(patch).toHaveBeenCalledOnce();
    }
  });

it.each(['ready', 'requester Home', 'admission refused', 'binding not current', 'missing declaration', 'non-204', 'typed non-204', 'unknown non-204', 'socket closed', 'refresh refused', 'slow catalog', 'slow refresh'] as const)(
  'opens the real Codex Team binder with the tracked recipient catalog, never custodian consent (%s)', async metadata => {
  const httpRefusal = metadata === 'non-204' || metadata === 'typed non-204' || metadata === 'unknown non-204';
  let h: Awaited<ReturnType<typeof createInstalledProjectAgentDaemonFixture>>;
  let model: TeamCredentialProviderModelCatalogEntryV1;
  let brokerOpens = 0;
  let catalogReads = 0;
  let consentCatalogReads = 0;
  const consentCatalogReadStacks: string[] = [];
  let refreshStream: (() => Promise<unknown>) | undefined;
  let nativeTunnelOpen: ReturnType<typeof createProviderBrokerMachineCarrierTunnelOpen> | undefined;
  let workerEndpoint: import('@happier-dev/protocol').IrohEndpointDescriptorV1 | undefined;
  let brokerEndpoint: import('@happier-dev/protocol').IrohEndpointDescriptorV1 | undefined;
  let workerRuntime: DaemonMachineIrohRuntime | undefined;
  let dropRequesterContext = false;
  let laterRefusal = false;
  let holdNextRefresh: (() => Promise<void>) | undefined;
  let daemonAccount: 'custodian' | 'requester' = 'custodian';
  const signingKey = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(91));
  const signedBrokerResponse = (request: ProviderBrokerOpenRequestV1) => {
    if (!workerEndpoint || !brokerEndpoint) throw new Error('Missing native endpoints');
    const issuedAt = Date.now();
    const payload = { v: 1 as const, aud: 'happier-provider-broker-route-v1' as const,
      grantId: 'grant', issuedAt, expiresAt: issuedAt + DIRECT_ROUTE_GRANT_TTL_MS.directTcpTunnel,
      teamId: 'team', resourceId: request.resourceId, sourceRevision: request.sourceRevision,
      brokerPlacementFingerprint: 'c'.repeat(64), initiatorTokenEpoch: 0,
      initiator: { accountId: 'requester', machineId: 'machine', endpointId: workerEndpoint.endpointId },
      target: { custodianAccountId: 'source-owner', machineId: 'broker', endpointId: brokerEndpoint.endpointId },
      consumer: request.consumer, application: request.application };
    return { ok: true as const, target: { custodianAccountId: 'source-owner', brokerMachineId: 'broker',
      endpointId: brokerEndpoint.endpointId, endpointRevision: 1, endpoint: brokerEndpoint },
      authority: { payload, signature: { alg: 'Ed25519' as const, keyId: 'home', valueBase64Url: Buffer.from(
        tweetnacl.sign.detached(Buffer.from(createProviderBrokerRouteGrantSigningInputV1(payload)), signingKey.secretKey),
      ).toString('base64url') } } };
  };
  const cleanup: Array<() => Promise<void>> = [];
  onTestFinished(async () => { for (const close of cleanup.reverse()) await close(); });
  const warnings = vi.spyOn(logger, 'warnLocalFile');
  if (metadata === 'requester Home') onTestFailed(() => console.error('Later Team broker admission', {
    brokerOpens, catalogReads, laterRefusal,
  }));
  if (metadata === 'slow catalog') onTestFailed(() => console.error('Team native discovery', {
    catalogReads, brokerOpens, warnings: warnings.mock.calls.filter(([label]) =>
      label === '[ProviderBroker] Endpoint discovery refused' || label === '[ProviderBroker] Machine stream admission refused'),
  }));
  h = await createInstalledProjectAgentDaemonFixture(() => boundary.control, 'codex', false, undefined, undefined, {
    openTeamCredentialProviderBinding: async input => {
      if (metadata === 'requester Home' || metadata === 'admission refused') {
        return await openDaemonSessionTeamCredentialProviderBinding({ ...input,
          ...(dropRequesterContext ? { providerSettingsOperationContext: undefined } : {}),
        }, { machineId: 'machine', accountId: daemonAccount, serverId: 'session-home', happyHomeDir: h.f.directory,
          credentials: daemonAccount === 'requester' ? h.requester.bootstrap.credentials : { token: 'custodian-token', encryption: null },
          serverHttpBaseUrl: h.requester.bootstrap.serverHttpBaseUrl,
          controller: h.plugin.controller, runtime: workerRuntime, resolveTrustRoots: () => [
            { keyId: 'home', publicKey: Buffer.from(signingKey.publicKey).toString('base64url') }],
          openTeamDirect: async () => { throw new Error('Unexpected direct material'); } });
      }
      const opened = await openSessionTeamCredentialProviderBinding({ ...input, machineId: 'machine',
        binding: { v: 1, slot: { kind: 'provider_model' }, resourceId: input.resourceId, expectedResourceRevision: input.expectedResourceRevision,
          deliveryMode: input.deliveryMode, teamId: input.teamId }, lease: h.plugin.lease,
        materializationBaseDir: join(h.f.directory, 'materialized'), readCatalog: async () => {
          // This is the Home catalog transport boundary. A valid read can
          // outlive native's pre-application custody window; it must not leave
          // an unused connection waiting for its first stream throughout it.
          if (++catalogReads === 2 && metadata === 'slow catalog') {
            await new Promise(resolve => setTimeout(resolve, MACHINE_CONTROL_TIMEOUT_MS + 1));
          }
          return [model];
        },
        openBroker: async request => {
          brokerOpens++;
          if (request.refreshAuthority && metadata === 'slow refresh') {
            await new Promise(resolve => setTimeout(resolve, MACHINE_CONTROL_TIMEOUT_MS + 1));
          }
          if (request.refreshAuthority && metadata === 'refresh refused') return { ok: false, reasonCode: 'broker_unavailable' };
          if (workerEndpoint && brokerEndpoint) {
            return signedBrokerResponse(request);
          }
          return { ok: true, target: { custodianAccountId: 'source-owner', brokerMachineId: 'broker', endpointId: 'b'.repeat(64),
            endpointRevision: 1, endpoint: { endpointId: 'b'.repeat(64) } }, authority: { payload: { v: 1,
              aud: 'happier-provider-broker-route-v1', grantId: 'grant', issuedAt: 1, expiresAt: 2,
              teamId: 'team', resourceId: request.resourceId, sourceRevision: request.sourceRevision,
              brokerPlacementFingerprint: 'c'.repeat(64), initiatorTokenEpoch: 0,
              initiator: { accountId: 'requester', machineId: 'machine', endpointId: 'a'.repeat(64) },
              target: { custodianAccountId: 'source-owner', machineId: 'broker', endpointId: 'b'.repeat(64) },
              consumer: request.consumer, application: request.application },
              signature: { alg: 'Ed25519', keyId: 'home', valueBase64Url: 'A'.repeat(86) } } };
        },
        openTunnel: async request => {
          if (nativeTunnelOpen) return await nativeTunnelOpen(request);
          const { refreshBrokerOpen } = request;
          refreshStream = refreshBrokerOpen;
          return { localPort: 43123, localCapability: 'synthetic-consumer-token', observedPath: 'direct',
            retire: async () => undefined, close: async () => undefined };
        },
      });
      if (!opened) throw new Error('Expected Team binding');
      return opened;
    },
  });
  const identity = h.plugin.registry.contributes.agentDefinitionsById.get('codex')?.identity;
  if (!identity) throw new Error('Missing admitted Codex identity');
  const agentTargetKey = `agent:${identity.pluginId}/${identity.localId}`;
  model = {
    selection: { kind: 'team_credential_provider_model', resourceId: 'resource', teamId: 'team', expectedResourceRevision: 2,
      deliveryMode: 'brokered', agentTargetKey, modelId: 'gpt-5.6-luna' },
    descriptor: { id: 'gpt-5.6-luna', name: 'Luna' }, sourceRevision: 'source-2', availability: 'available',
    application: { agentTargetKey, implementationIdentity: { pluginId: 'happier.provider.cliproxyapi', localId: 'cliproxyapi' },
      endpointTemplateId: 'responses', protocol: 'openai-responses' },
    sourceFacts: ProviderModelBindingSourceV1Schema.parse({ endpoint: { id: 'responses', protocol: 'openai-responses',
      capabilities: { streaming: 'supported', toolRoundTrips: 'supported', statefulResponses: 'supported', reasoningControls: 'supported' } },
      compatibilityOverrides: [{ agentTargetKey, protocol: 'openai-responses', status: 'experimental', reason: 'Recipient-only consent' }] }),
  };
  h.tracked.spawnOptions = { ...h.tracked.spawnOptions, teamCredentialBindings: [{ v: 1, slot: { kind: 'provider_model' },
    resourceId: 'resource', expectedResourceRevision: 2, teamId: 'team', deliveryMode: 'brokered' }],
    modelSelection: { v: 1, updatedAt: 1, ref: { agentTargetKey, providerConnectionId: null, modelId: model.descriptor.id } } };
  const compatibility = await resolveTeamCredentialModelCompatibility({ lease: h.plugin.lease, agentId: 'codex',
    model: { ...model, deliveryMode: 'brokered' } });
  expect(compatibility).toMatchObject({ result: { status: 'experimental' }, confirmed: true });
  const snapshot = h.requester.readAccountSettingsSnapshot();
  if (!snapshot) throw new Error('Missing recipient snapshot');
  const ambient = { ...snapshot, scopeKey: 'custodian-account', providerConnectionsCatalog: {
    status: 'ready' as const, revision: 1, catalog: splitProviderSettingsV1(DEFAULT_PROVIDER_SETTINGS_V1).catalog } };
  setActiveAccountSettingsSnapshot(ambient);
  const get = vi.mocked(axios.get).getMockImplementation()!;
  vi.mocked(axios.get).mockImplementation(async (url, options) => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/account/entity-rows/provider-connections') {
      consentCatalogReads++;
      consentCatalogReadStacks.push(new Error('Unexpected personal Provider catalog read for Team binding').stack ?? 'stack unavailable');
      expect(options?.headers?.Authorization).toBe(`Bearer ${h.requester.bootstrap.credentials.token}`);
      return { status: 200, data: { status: 'present', revision: 2, content: { t: 'plain', v: splitProviderSettingsV1(DEFAULT_PROVIDER_SETTINGS_V1).catalog } } };
    }
    if (path === '/v2/account/settings/history') return { status: 200, data: { snapshots: [] } };
    const history = emptyAccountSettingsHistoryCaptureResponse(path);
    if (history) return history;
    return get(url, options);
  });
  const fetchBoundary = vi.mocked(fetch).getMockImplementation()!;
  if (metadata === 'requester Home' || metadata === 'admission refused') {
    const post = vi.mocked(axios.post).getMockImplementation()!;
    vi.mocked(axios.post).mockImplementation(async (url, data, options) => {
      const path = new URL(String(url)).pathname;
      if (path === TEAM_CREDENTIAL_ACTION_PATHS_V1['teams.credentials.entitled.list']) {
        catalogReads++;
        // This real Home HTTP boundary exposes the Team only to its recipient.
        // The strict page/model readers beneath it stay real.
        const recipient = options?.headers?.Authorization === `Bearer ${h.requester.bootstrap.credentials.token}`;
        return { status: 200, data: { resources: recipient ? [TeamCredentialResourceCatalogEntryV1Schema.parse({
          id: 'resource', teamId: 'team', displayName: 'Shared Pool', resourceRevision: 2,
          readiness: { kind: 'available' }, recoveryAction: null, mayBroker: true, mayReceiveDirect: false,
          directMaterialState: 'never_delivered', sessionUsePolicy: 'personal_allowed',
          sourcePresentation: { kind: 'connected_service', service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' } },
          connectedServiceSelections: [], providerModels: [model],
        })] : [], nextCursor: null } };
      }
      if (path === PROVIDER_BROKER_OPEN_HTTP_PATH_V1) {
        expect(options?.headers?.Authorization).toBe(`Bearer ${h.requester.bootstrap.credentials.token}`);
        brokerOpens++;
        if (metadata === 'admission refused') return { status: 200, data: { ok: false, reasonCode: 'broker_unavailable' } };
        const request = ProviderBrokerOpenRequestV1Schema.parse(data);
        if (request.refreshAuthority) {
          const heldRefresh = holdNextRefresh;
          holdNextRefresh = undefined;
          await heldRefresh?.();
          if (laterRefusal) return { status: 200, data: { ok: false, reasonCode: 'resource_forbidden' } };
        }
        return { status: 200, data: signedBrokerResponse(request) };
      }
      return post(url, data, options);
    });
  }
  if (metadata === 'slow catalog' || metadata === 'slow refresh' || metadata === 'refresh refused' || metadata === 'requester Home' || metadata === 'admission refused') {
    // The target HTTP service is the external boundary. Keep real signed
    // cross-Account admission, native Iroh and capability gating in the path.
    const http = createServer((request, response) => {
      if (request.url === PROVIDER_BROKER_PRIVATE_ENDPOINT_PATH) {
        response.writeHead(204, { [PROVIDER_BROKER_ENDPOINT_PATH_HEADER]: '/v1' }).end();
      } else response.writeHead(204).end();
    });
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
    cleanup.push(() => new Promise<void>((resolve, reject) => {
      http.close(error => error ? reject(error) : resolve()); http.closeAllConnections();
    }));
    const address = http.address();
    if (!address || typeof address === 'string') throw new Error('Missing broker HTTP target');
    const worker = await createDaemonMachineIrohRuntime({ happyHomeDir: h.f.directory, identity: 'ephemeral',
      relayConfig: { relayPolicy: 'disabled', relayUrls: [] } });
    cleanup.push(worker.shutdown);
    const broker = await createDaemonMachineIrohRuntime({ happyHomeDir: h.f.directory, identity: 'ephemeral',
      relayConfig: { relayPolicy: 'disabled', relayUrls: [] } });
    cleanup.push(broker.shutdown);
    if (!worker.available || !broker.available) throw new Error('Expected native Team endpoints');
    workerRuntime = worker;
    workerEndpoint = worker.endpoint;
    brokerEndpoint = broker.endpoint;
    const trustRoots = [{ keyId: 'home', publicKey: Buffer.from(signingKey.publicKey).toString('base64url') }];
    const admission = await startPeerMediationLoopbackServer({ nowMs: Date.now,
      expected: { accountId: 'source-owner', machineId: 'broker', flowKind: 'machine_rpc',
        routeKind: 'loopback_direct', endpointFingerprint: broker.endpoint.endpointId },
      trustRoots, endpointExpiresAt: Date.now() + DIRECT_ROUTE_GRANT_TTL_MS.directTcpTunnel,
      irohMachineAdmission: { localEndpointId: broker.endpoint.endpointId, role: 'acceptor', allowedFlows: [],
        resolveApplicationTarget: async () => null,
        resolveProviderBrokerApplicationTarget: async () => ({ port: address.port }) },
    });
    cleanup.push(admission.stop);
    await broker.startAttemptAcceptor({ admissionPort: Number(new URL(admission.url).port) });
    nativeTunnelOpen = createProviderBrokerMachineCarrierTunnelOpen({ accountId: 'requester', localMachineId: 'machine',
      runtime: worker, resolveTrustRoots: () => trustRoots, fetchImpl: nativeFetch });
  }
  vi.mocked(fetch).mockImplementation(async (url, options) => {
    const target = new URL(String(url));
    if (target.pathname === AGENT_RUNTIME_DAEMON_SERVICES_PATH && target.hostname === '127.0.0.1'
      && target.port === String(boundary.port)) return nativeFetch(url, options);
    if (target.pathname === PROVIDER_BROKER_PRIVATE_ENDPOINT_PATH) {
      if (metadata === 'slow catalog' || metadata === 'slow refresh' || metadata === 'requester Home') return nativeFetch(url, options);
      // Native transport is the boundary: a failed fresh handshake closes its
      // local HTTP socket without returning an HTTP response to the real binder.
      if (metadata === 'refresh refused') await refreshStream?.();
      if (metadata === 'socket closed' || metadata === 'refresh refused') {
        throw new TypeError('fetch failed', { cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }) });
      }
      return new Response(null, { status: httpRefusal ? 403 : 204,
        headers: metadata === 'missing declaration' ? {} : {
          [PROVIDER_BROKER_ENDPOINT_PATH_HEADER]: '/v1',
          ...(metadata === 'typed non-204' ? { [PROVIDER_BROKER_APPLICATION_ERROR_CODE_HEADER]: 'session_not_active' } : {}),
          ...(metadata === 'unknown non-204' ? { [PROVIDER_BROKER_APPLICATION_ERROR_CODE_HEADER]: 'private-unknown-reason' } : {}),
        } });
    }
    return fetchBoundary(url, options);
  });
  const open = () => h.dispatch({ kind: 'provider_broker.binding.open', requestId: 'recipient-team-open',
    resourceId: 'resource', expectedResourceRevision: 2, agentTargetKey, modelId: model.descriptor.id });
  const path = await createAgentRuntimeDaemonServiceAuthorityPath({ happyHomeDir: configuration.happyHomeDir,
    publicReleaseRing: configuration.publicReleaseRing });
  // The bundled development Agent belongs to this real source runner root.
  h.runner.snapshotIdentity = `path:${resolve(__dirname, '../../..')}`;
  // The runner source admits only the exact live process; the OS identity read is the boundary.
  const runnerCommand = `${process.execPath} ${resolve(__dirname, '../../..', 'src/index.ts')} codex --started-by daemon`;
  h.runner.processCommandHash = hashProcessCommand(runnerCommand);
  vi.spyOn(processIdentity, 'readProcessIdentityByPid').mockResolvedValue({ pid: process.pid,
    processStartTimeMs: h.runner.processStartTimeMs, command: runnerCommand });
  const authority = { happyHomeDir: configuration.happyHomeDir, publicReleaseRing: configuration.publicReleaseRing,
    path, sessionId: h.sessionId, runner: h.runner, retainedAgent: h.retainedAgent };
  const published = await publishAgentRuntimeDaemonServiceAuthority({ ...authority,
    httpPort: boundary.port, capability: 'A'.repeat(43), readPluginHardRevocationRevision: async () => 0 });
  h.tracked.agentRuntimeDaemonServiceAuthorityFilePath = path;
  h.tracked.agentRuntimeDaemonServiceCapabilityHash = published.capabilityDigest;
  const openThroughRunner = () => openCurrentRunnerTeamCredentialProviderBinding({ authority, operation: {
    kind: 'provider_broker.binding.open', resourceId: 'resource', expectedResourceRevision: 2,
    agentTargetKey, modelId: model.descriptor.id } });
  try {
  if (metadata === 'admission refused') {
    const refusal = await openThroughRunner().then(() => null, (error: unknown) => error);
    expect(refusal).toMatchObject({ code: 'broker_unavailable' });
    expect(boundary.responseBody).toMatchObject({ ok: false, error: { code: 'broker_unavailable' } });
    expect(classifyPrimarySessionRuntimeIssue({ cause: 'session_error', error: refusal }))
      .toMatchObject({ source: 'team_credential', code: 'broker_unavailable' });
    expect(brokerOpens).toBe(1);
    return;
  }
  if (metadata === 'requester Home') {
    const source = await createRunnerAgentSessionRuntimeSource({ happyHomeDir: configuration.happyHomeDir,
      publicReleaseRing: configuration.publicReleaseRing, authorityFilePath: path, expectedSessionId: h.sessionId,
      occurrenceId: 'c165-refusal-runner' });
    if (!source?.prepareTeamCredentialProviderBinding || !source.daemonTurnContributionsBridge?.readTeamCredentialDenial) {
      throw new Error('Missing runner Team credential composition');
    }
    const readTeamCredentialDenial = source.daemonTurnContributionsBridge.readTeamCredentialDenial;
    onTestFinished(() => source.retire?.());
    const opened = await source.prepareTeamCredentialProviderBinding({ sessionId: h.sessionId,
      resourceId: 'resource', expectedResourceRevision: 2, agentTargetKey, modelId: model.descriptor.id,
      signal: h.signal });
    expect(opened.providerBinding).toMatchObject({ source: { kind: 'team_resource', resourceId: 'resource' },
      upstream: { normalizedUrl: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/v1$/u) } });
    expect(parseCodexProviderBindingEngineConfigV1(opened.providerBinding)).not.toBeNull();
    expect(catalogReads).toBeGreaterThan(0);
    expect(brokerOpens).toBeGreaterThan(0);
    const credential = opened.environmentOverlay.find(entry => entry.name === 'HAPPIER_CODEX_PROVIDER_API_KEY')?.value;
    if (!credential) throw new Error('Missing scoped native carrier credential');
    // Fresh admission belongs to each native TCP stream. Never reuse the
    // already-admitted endpoint-discovery connection for this request.
    const requestApplication = () => new Promise<{ status: number; body: string }>((resolve, reject) => {
      const request = requestHttp(opened.providerBinding.upstream.normalizedUrl, {
        agent: false,
        headers: { authorization: `Bearer ${credential}`, [MACHINE_HTTP_LOCAL_CAPABILITY_HEADER]: credential },
      }, response => {
        const chunks: Buffer[] = [];
        response.on('data', chunk => { chunks.push(Buffer.from(chunk)); });
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
        response.on('error', reject);
      });
      request.on('error', reject);
      request.end();
    });
    h.tracked.activeTurnId = 'later-refusal-turn';
    laterRefusal = true;
    const beforeRefusal = brokerOpens;
    const denied = await requestApplication().catch(() => null);
    // Older loaded native addons can collapse this refusal into a socket
    // close. Host evidence must survive either Agent-visible boundary outcome.
    expect(brokerOpens).toBe(beforeRefusal + 1);
    expect(await readCurrentRunnerTeamCredentialBrokerDenial({ authority, turnId: 'another-turn' })).toBeNull();
    const mutations: SessionTurnMutationV1[] = [];
    const lifecycle = createSessionTurnLifecycle({
      session: { sessionId: h.sessionId, enqueueSessionTurnMutation: async mutation => { mutations.push(mutation); } },
      readTeamCredentialDenial: turnId => readTeamCredentialDenial({ sessionId: h.sessionId, turnId }),
    });
    lifecycle.observeRuntimeEvent({ sequence: 0, sessionId: h.sessionId, emittedAtMs: 100,
      kind: 'turn-start', turnId: 'later-refusal-turn', startedBy: 'host' });
    lifecycle.observeRuntimeEvent({ sequence: 1, sessionId: h.sessionId, emittedAtMs: 101,
      kind: 'turn-failed', turnId: 'later-refusal-turn',
      diagnostic: { code: 'codex_app_server_turn_failed', severity: 'error', message: 'Codex app-server turn failed.',
        details: { v: 1, source: 'agent_session_error' } } });
    await lifecycle.drainAcceptedLifecycle();
    const failure = mutations.find(mutation => mutation.action === 'fail');
    expect(failure).toMatchObject({ issue: { source: 'team_credential',
      teamCredential: { resourceId: 'resource', reasonCode: 'resource_forbidden' } } });
    if (failure?.action !== 'fail') throw new Error('Missing failed Session turn');
    expect(presentSessionTeamCredentialDenial({ issue: failure.issue,
      resolveResourceDisplayName: () => 'Shared Pool' })).toMatchObject({ resourceId: 'resource',
        action: 'choose-model', body: expect.stringContaining('Shared Pool') });
    lifecycle.observeRuntimeEvent({ sequence: 2, sessionId: h.sessionId, emittedAtMs: 102,
      kind: 'turn-start', turnId: 'later-refusal-turn', startedBy: 'host' });
    lifecycle.observeRuntimeEvent({ sequence: 3, sessionId: h.sessionId, emittedAtMs: 103,
      kind: 'turn-cancelled', turnId: 'later-refusal-turn', cause: 'user' });
    await lifecycle.drainAcceptedLifecycle();
    expect(mutations.at(-1)?.action).toBe('cancel');
    laterRefusal = false;
    const accepted = await requestApplication();
    expect(accepted.status).toBe(204);
    expect(await readCurrentRunnerTeamCredentialBrokerDenial({ authority, turnId: 'later-refusal-turn' })).toBeNull();
    // A Home read that outlives this turn cannot attribute its denial to the successor.
    let notifyRefreshStarted = () => {};
    let releaseRefresh = () => {};
    const refreshStarted = new Promise<void>(resolve => { notifyRefreshStarted = resolve; });
    const refreshReleased = new Promise<void>(resolve => { releaseRefresh = resolve; });
    holdNextRefresh = async () => { notifyRefreshStarted(); await refreshReleased; };
    laterRefusal = true;
    const lateRequest = requestApplication();
    try {
      await refreshStarted;
      h.tracked.activeTurnId = 'successor-turn';
    } finally { releaseRefresh(); }
    await lateRequest.catch(() => null);
    expect(await readCurrentRunnerTeamCredentialBrokerDenial({ authority, turnId: 'successor-turn' })).toBeNull();
    laterRefusal = false;
    const priorBrokerOpens = brokerOpens;
    // Deliberately remove the requester binding once. This is the original
    // mis-wiring: a valid Team selection disappears in the custodian catalog.
    dropRequesterContext = true;
    await expect(openThroughRunner()).rejects.toMatchObject({ code: 'team_credential_provider_selection_not_current' });
    expect(brokerOpens).toBe(priorBrokerOpens);
    // A daemon's own Account still uses the same composition without a
    // separate requester context or an alternate catalog/broker path.
    daemonAccount = 'requester';
    const ownAccountSnapshot = h.requester.readAccountSettingsSnapshot();
    if (!ownAccountSnapshot) throw new Error('Missing own Account confirmation');
    setActiveAccountSettingsSnapshot(ownAccountSnapshot);
    await expect(openThroughRunner()).resolves.toMatchObject({ kind: 'provider_broker.binding', status: 'opened' });
    return;
  }
  if (metadata === 'binding not current') {
    h.tracked.spawnOptions = { ...h.tracked.spawnOptions, teamCredentialBindings: [{ v: 1, slot: { kind: 'provider_model' },
      resourceId: 'other-resource', expectedResourceRevision: 2, teamId: 'team', deliveryMode: 'brokered' }] };
    const refused = await openThroughRunner().then(() => null, (error: unknown) => error);
    expect(brokerOpens).toBe(0);
    expect(boundary.responseStatus).toBe(200);
    expect(boundary.responseBody).toEqual({ ok: false, error: {
      code: 'team_credential_provider_selection_not_current', message: 'team_credential_provider_selection_not_current' } });
    expect(refused).toMatchObject({ code: 'team_credential_provider_selection_not_current' });
    expect(readSessionPreparationFailureDiagnostic(refused).originalCode).toBe('team_credential_provider_selection_not_current');
    return;
  }
  if (metadata !== 'ready' && metadata !== 'slow catalog' && metadata !== 'slow refresh') {
    const refused = await openThroughRunner().then(() => null, (error: unknown) => error);
    expect(brokerOpens).toBe(metadata === 'refresh refused' ? 2 : 1);
    expect(warnings.mock.calls).toContainEqual(['[ProviderBroker] Endpoint discovery refused', expect.objectContaining({
      reason: 'endpoint_discovery_failed',
      discoveryCause: metadata === 'refresh refused' ? 'broker_refresh_refused' : metadata === 'socket closed'
        ? 'socket_closed' : metadata === 'missing declaration' ? 'invalid_metadata' : 'http_response',
      discoveryElapsedMs: expect.any(Number),
      refreshOutcome: metadata === 'refresh refused' ? 'refused' : 'not_requested',
      ...(metadata === 'refresh refused' ? { refreshElapsedMs: expect.any(Number) } : {}),
      ...(metadata === 'socket closed' || metadata === 'refresh refused' ? {} : { httpStatus: httpRefusal ? 403 : 204 }),
    })]);
    const discoveryRecord = warnings.mock.calls.find(([label]) => label === '[ProviderBroker] Endpoint discovery refused')?.[1];
    if (metadata === 'socket closed' || metadata === 'refresh refused') expect(discoveryRecord).not.toHaveProperty('httpStatus');
    for (const privateValue of ['synthetic-consumer-token', 'source-owner', 'requester', 'other side closed', 'private-unknown-reason']) {
      expect(JSON.stringify(discoveryRecord)).not.toContain(privateValue);
    }
    expect(boundary.responseStatus).toBe(200);
    // The canonical endpoint reader distinguishes a broker HTTP refusal from
    // an unavailable endpoint projection (204 without its declaration).
    const expectedCode = metadata === 'typed non-204' ? 'session_not_active'
      : httpRefusal ? 'broker_unavailable' : 'provider_endpoint_unavailable';
    expect(boundary.responseBody).toEqual({ ok: false,
      error: { code: expectedCode, message: expectedCode } });
    expect(refused).toMatchObject({ code: expectedCode, message: expectedCode });
    if (httpRefusal) {
      expect(classifyPrimarySessionRuntimeIssue({ cause: 'session_error', error: refused }))
        .toMatchObject({ source: 'team_credential', code: expectedCode });
    }
    expect(readSessionPreparationFailureDiagnostic(refused)).toEqual({
      originalCode: expectedCode, reason: 'unknown', contextSource: 'unknown' });
    return;
  }
  const opened = await openThroughRunner();
  expect(opened).toMatchObject({ kind: 'provider_broker.binding', status: 'opened',
    providerBinding: { source: { kind: 'team_resource', resourceId: 'resource', resourceRevision: 2 }, model: model.descriptor,
      upstream: { protocol: 'openai-responses', normalizedUrl: metadata === 'slow catalog' || metadata === 'slow refresh'
        ? expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/v1$/u) : 'http://127.0.0.1:43123/v1', credential: 'apiKey' } } });
  const config = parseCodexProviderBindingEngineConfigV1(opened.providerBinding);
  if (!config) throw new Error('Expected Codex engine config');
  expect(config.config[`model_providers.${config.modelProvider}`]).toMatchObject({
    env_http_headers: { 'x-happier-machine-local-capability': 'HAPPIER_CODEX_PROVIDER_API_KEY' },
  });
  expect(h.requester.readAccountSettingsSnapshot()?.providerConnectionsCatalog).toBeUndefined();
  expect(consentCatalogReads, consentCatalogReadStacks.join('\n')).toBe(0);
  expect(getActiveAccountSettingsSnapshot()).toEqual(ambient);
  expect(brokerOpens).toBe(metadata === 'slow catalog' || metadata === 'slow refresh' ? 2 : 1);
  h.f.retire();
  await expect(open()).rejects.toThrow('requester_session_not_current');
  expect(brokerOpens).toBe(metadata === 'slow catalog' || metadata === 'slow refresh' ? 2 : 1);
  } finally {
    await removeAgentRuntimeDaemonServiceAuthorityIfOwned({ happyHomeDir: configuration.happyHomeDir,
      publicReleaseRing: configuration.publicReleaseRing, path, capabilityDigest: published.capabilityDigest });
  }
});
