import { createHash } from 'node:crypto';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import axios from 'axios';
import { afterEach, expect, it, onTestFinished, vi } from 'vitest';
import { resolveManagedToolsRoot } from '@happier-dev/cli-common/agents';
import { accountSettingsParse, normalizeActionsSettingsV1, setActionApprovalOverride } from '@happier-dev/protocol';
import { COMPUTER_CUA_DRIVER_INSTALLABLE_DESCRIPTOR, COMPUTER_CUA_DRIVER_INSTALLABLE_KEY, COMPUTER_CUA_DRIVER_VERSION } from '@happier-dev/protocol/installables';
import { ExternalActionRequestEnvelopeV1Schema, externalActionExecutionAuthorizationRequestSchemaForActionV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { bootstrapAccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { configuration } from '@/configuration';
import * as persistence from '@/persistence';
import * as processIdentity from '@/daemon/processIdentity';
import { hashProcessCommand } from '@/daemon/sessionRegistry';
import { createInstalledProjectAgentDaemonFixture } from '@/daemon/testkit/installedProjectAgentDaemonFixture';
import { createMachineLiveStreamCaptureRegistry } from '@/daemon/peer/mediation/stream/captureRegistry';
import { createAgentRuntimeDaemonServiceAuthorityPath, publishAgentRuntimeDaemonServiceAuthority } from '@/daemon/agentRuntime/sessionBridgeAuthorization';
import { createRunnerAgentSessionRuntimeSource } from '@/agent/runtime/session/process/runnerAgentSessionRuntimeSource';
import { resolveCliEngineRegistry } from '@/agent/runtime/registry/engineRegistry/registry';
import { createHappierMcpServer } from '@/mcp/createHappierMcpServer';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { AgentRuntimeDaemonServiceResponseV1Schema } from '@/agent/runtime/session/process/agentRuntimeDaemonServiceProtocol';
import type { startDaemonControlServer } from '@/daemon/controlServer';
import { native } from '@/daemon/computer/driver/nativeComputerBoundary.testkit';
import { createDaemonRuntimeActionExecutor } from '@/daemon/runtimeActionExecutor';
import type { ComputerRoutes } from '@/daemon/computer/routes';

const boundary = vi.hoisted(() => ({ control: null as Parameters<typeof startDaemonControlServer>[0] | null, port: 0,
  refusal: null as unknown }));
// Bind a real private HTTP listener on an OS-assigned port. Every control route,
// runner admission, Session recovery and Computer requester decision stays real.
vi.mock('@/daemon/controlServer', async original => {
  const actual = await original<typeof import('@/daemon/controlServer')>();
  return { ...actual, startDaemonControlServer: async (input: Parameters<typeof startDaemonControlServer>[0]) => {
    boundary.control = input;
    const app = actual.createDaemonControlApp(input);
    app.addHook('onSend', async (_request, _reply, payload) => {
      if (typeof payload !== 'string') return payload;
      const parsed = AgentRuntimeDaemonServiceResponseV1Schema.safeParse(JSON.parse(payload));
      if (parsed.success && parsed.data.ok && parsed.data.result.kind === 'action.execution' && !parsed.data.result.outcome.ok) {
        const failure = parsed.data.result.outcome;
        boundary.refusal = { errorCode: failure.errorCode, details: failure.details };
      }
      return payload;
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('Missing private HTTP address');
    boundary.port = address.port;
    return { port: address.port, stop: async () => app.close() };
  } };
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); boundary.control = null; boundary.refusal = null; });

it('lets an ordinary owner Session agent list its own Machine through runner MCP with isolation Off', async () => {
  const realFetch = globalThis.fetch;
  // Daemon startup captures its OS desktop before the runner/MCP is created.
  vi.stubEnv('DISPLAY', ':73');
  const settings = accountSettingsParse({ actionsSettingsV1: setActionApprovalOverride({
    settings: normalizeActionsSettingsV1({}), actionId: 'computer.targets.list', surface: 'agent', approvalRequired: false,
  }) });
  const registry = createMachineLiveStreamCaptureRegistry();
  let computer: ComputerRoutes | null = null;
  const h = await createInstalledProjectAgentDaemonFixture(() => boundary.control, undefined, true, undefined, undefined, {
    ordinaryAccountSession: true, externalActionAccountId: 'requester', agentIsolationEnabled: false,
    machineAccess: { custodianAccountId: 'requester', role: 'manage' }, accountSettings: settings,
    liveStreamCaptureRegistry: registry, processEnv: { DISPLAY: ':73' },
    onComputerRoutesReady: provider => { computer = provider(); },
    runtimeActionExecute: createDaemonRuntimeActionExecutor({ env: {}, resolveRouteOwners: () => ({ computer: computer ?? undefined }),
      resolveServerFeaturesSnapshot: () => undefined }),
    resolveCurrentMachineExecutionOriginContext: async () => ({ machineId: 'machine', serverIdentityId: 'srv_computer_owner' }),
    runnerIdentity: directory => ({ pid: process.pid, processStartTimeMs: 1, snapshotIdentity: 'snapshot:fixture-runner',
      processCommandHash: hashProcessCommand(`${process.execPath} ${join(directory, '.runner-snapshots', 'fixture-runner', 'index.mjs')}`) }),
  });
  expect(h.tracked.requesterWorkAttributionV1).toBeUndefined();
  expect(h.tracked.requesterSessionRuntimeContext).toBeUndefined();
  if (!h.installedCredentials) throw new Error('Missing owner Account credentials');
  // Ordinary Sessions consume the active Account policy, through its real
  // settings owner. Admit only this read so requester selection is the deciding boundary.
  await bootstrapAccountSettingsContext({ credentials: h.installedCredentials, mode: 'blocking', refresh: 'force',
    publication: 'active', expectedAccountEncryptionMode: 'plain' });
  // Home is the network authority boundary. Its response binds the actual
  // request envelope and source Session; daemon admission/verification stay real.
  const homePost = vi.mocked(axios.post).getMockImplementation();
  vi.mocked(axios.post).mockImplementation(async (url, raw, config) => {
    if (String(url).endsWith('/execution-authorization')) {
      const actionId = String(url).split('/').at(-2)!;
      const request = externalActionExecutionAuthorizationRequestSchemaForActionV1(actionId).parse(raw);
      const envelope = ExternalActionRequestEnvelopeV1Schema.parse(request.envelope);
      return { status: 200, data: { v: 1, token: 'computer-owner-home-proof', binding: {
        serverIdentityId: 'srv_computer_owner', accountId: 'requester', custodianAccountId: 'requester',
        authentication: { kind: 'terminal', tokenEpoch: 0 }, accountEncryptionMode: 'plain', machineId: 'machine',
        installationId: h.f.installation.installationId, actionId, requestId: envelope.requestId, target: envelope.target,
        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
        sessionActionOrigin: request.sessionActionOrigin, sessionActionSource: request.sessionActionSource,
      } } };
    }
    if (String(url).endsWith('/execution-authorization/verify')) return { status: 200, data: { ok: true } };
    if (!homePost) throw new Error('Missing Home HTTP fixture');
    return homePost(url, raw, config);
  });
  // An installed native executable is filesystem custody. Only its subprocess
  // MCP boundary is substituted; provider resolution and output parsing are real.
  const descriptor = COMPUTER_CUA_DRIVER_INSTALLABLE_DESCRIPTOR;
  if (descriptor.source.kind !== 'pinned_archive') throw new Error('Expected native driver archive');
  const asset = Object.entries(descriptor.source.assetsByPlatform).find(([key]) => key === `${process.platform}-${process.arch}`)?.[1];
  if (!asset) throw new Error('Unsupported native driver test platform');
  const root = join(resolveManagedToolsRoot({ ...process.env, HAPPIER_HOME_DIR: h.f.directory }), COMPUTER_CUA_DRIVER_INSTALLABLE_KEY, 'current');
  const executable = join(root, asset.executableSubpath);
  const bytes = 'synthetic Computer subprocess boundary';
  await mkdir(dirname(executable), { recursive: true });
  await writeFile(executable, bytes); await chmod(executable, 0o700);
  await writeFile(join(root, '.happier-managed-version'), COMPUTER_CUA_DRIVER_VERSION);
  await writeFile(join(root, '.happier-managed-executable-sha256'), `sha256:${createHash('sha256').update(bytes).digest('hex')}`);
  native.call.mockImplementation(async ({ name }) => name === 'list_windows'
    ? { structuredContent: { windows: [{ pid: 42, window_id: 123, title: 'Synthetic canary' }] } }
    : { structuredContent: { x11: true, xsend_event: true } });
  const homeFetch = globalThis.fetch;
  vi.stubGlobal('fetch', (url: Parameters<typeof fetch>[0], init?: RequestInit) =>
    new URL(String(url)).hostname === '127.0.0.1' ? realFetch(url, init) : homeFetch(url, init));
  const command = `${process.execPath} ${join(h.f.directory, '.runner-snapshots', 'fixture-runner', 'index.mjs')}`;
  vi.spyOn(processIdentity, 'readProcessIdentityByPid').mockResolvedValue({ pid: process.pid,
    processStartTimeMs: h.runner.processStartTimeMs, command });
  const path = await createAgentRuntimeDaemonServiceAuthorityPath({ happyHomeDir: h.f.directory, publicReleaseRing: configuration.publicReleaseRing });
  const published = await publishAgentRuntimeDaemonServiceAuthority({ happyHomeDir: h.f.directory, publicReleaseRing: configuration.publicReleaseRing,
    path, sessionId: h.sessionId, runner: h.runner, retainedAgent: h.retainedAgent, httpPort: boundary.port });
  h.tracked.agentRuntimeDaemonServiceAuthorityFilePath = path;
  h.tracked.agentRuntimeDaemonServiceCapabilityHash = published.capabilityDigest;
  vi.stubEnv('HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE', path);
  vi.spyOn(persistence, 'readDaemonState').mockResolvedValue({ pid: process.pid, httpPort: boundary.port,
    controlToken: 'A'.repeat(43), startedAt: 1, startedWithCliVersion: 'test' });
  const source = await createRunnerAgentSessionRuntimeSource({ happyHomeDir: h.f.directory,
    publicReleaseRing: configuration.publicReleaseRing, authorityFilePath: path, expectedSessionId: h.sessionId });
  if (!source) throw new Error('Missing real runner admission');
  onTestFinished(() => source.retire?.());
  const engines = await resolveCliEngineRegistry({ happyHomeDir: h.f.directory, backendId: source.identity.backendId,
    requireRunnerAgentSessionRuntimeSource: true, runnerAgentSessionRuntimeSource: source });
  const resolution = await engines.resolveForBackendId(source.identity.backendId);
  if (!resolution) throw new Error('Missing real Session Agent runtime');
  await resolution.engineAdapter.runtimeCore.createSessionRuntime({ credentials: h.installedCredentials!,
    directory: h.cwd, backendTarget: { kind: 'backend', backendId: source.identity.backendId } });
  const witness = { turnId: 'computer-owner-turn', inputId: 'computer-owner-input', userMessageSeq: 1, userMessageSeqs: [1],
    callerPermissionMode: 'default' as const,
    causalPermissionAuthority: { kind: 'admittedSessionInputV1' as const, admittedPermissionCeiling: 'default' as const },
    agentStartCaller: { kind: 'session' as const, sessionId: h.sessionId, starterDepth: 0, turnDepth: 0 } };
  h.tracked.agentRuntimeDaemonServiceAdmittedTurnId = witness.turnId;
  h.tracked.agentRuntimeDaemonServiceAdmittedInputId = witness.inputId;
  h.tracked.agentRuntimeDaemonServiceAdmittedUserMessageSeq = 1;
  h.tracked.agentRuntimeDaemonServiceAdmittedUserMessageSeqs = [1];
  const runtime = createHappierMcpServer({ sessionId: h.sessionId, updateMetadata() {},
    getServerBinding: () => ({ serverId: 'session-home', serverUrl: 'https://session-home.test' }),
    rpcHandlerManager: new RpcHandlerManager({ scopePrefix: h.sessionId, encryptionMode: 'plain' }),
    getMetadataSnapshot: () => createTestMetadata({ machineId: 'machine' }), getWorkDepth: () => 0, getHostTurnWorkDepth: () => 0,
    getPermissionMode: () => 'default', getActiveTurnAdmissionWitness: () => witness,
    getActiveTurnPermissionWitness: () => ({ turnId: witness.turnId, causalPermissionAuthority: witness.causalPermissionAuthority }),
    getStoredContentEncryptionContext: () => ({ mode: 'plain' }) }, {
    authorityScope: 'session', credentials: null, sessionCredentials: { token: 'restricted-runner-bearer', encryption: null }, accountSettings: settings,
  });
  const client = new Client({ name: 'Computer-owner-agent', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await runtime.mcp.connect(serverTransport); await client.connect(clientTransport);
  onTestFinished(async () => { await client.close(); await runtime.mcp.close(); });
  const result = CallToolResultSchema.parse(await client.callTool({ name: 'action_execute',
    arguments: { actionId: 'computer.targets.list', input: { machineId: 'machine' } } }));
  const block = result.content.find(item => item.type === 'text');
  if (!block || block.type !== 'text') throw new Error('Missing Computer MCP result');
  const outcome: unknown = JSON.parse(block.text);
  expect({ isError: result.isError ?? false, outcome }, JSON.stringify({ outcome, refusal: boundary.refusal }))
    .toMatchObject({ isError: false, outcome: { targets: [{ target: { kind: 'window', pid: 42, windowId: 123 } }] } });
  expect(native.tools.some(tool => tool.name === 'list_windows')).toBe(true);
});
