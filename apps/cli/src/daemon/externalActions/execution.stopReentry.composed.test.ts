import axios, { AxiosHeaders } from 'axios';
import nacl from 'tweetnacl';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { afterEach, expect, it, onTestFinished, vi } from 'vitest';
import { createInstalledProjectAgentDaemonFixture } from '@/daemon/testkit/installedProjectAgentDaemonFixture';
import type { startDaemonControlServer } from '@/daemon/controlServer';
import { readProcessIdentityByPid } from '@/daemon/processIdentity';
import { hashProcessCommand } from '@/daemon/sessionRegistry';
import { logger } from '@/ui/logger';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { buildSessionMetadataEnvelopeFields } from '@/session/metadata/buildSessionMetadataEnvelopeCreateFields';
import { EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER, ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1, verifyExternalActionMachineRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { sealExternalActionRequesterAccountContextV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { SessionMetadataTuplePatchV1Schema, SessionMetadataTuplePatchSuccessV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { encodeStoredCredentials } from '@/persistence';
import { tryDecryptSessionOwnerMetadataView } from '@/session/transport/encryption/sessionEncryptionContext';
import { readSessionExplicitStopV1FromMetadata } from '@happier-dev/protocol/sessions/metadata/sessionExplicitStopV1';
import { executeExternalAction } from './executeExternalAction';
import { verifyExternalActionExecutionAuthorizationCurrent } from '@/api/externalActionExecutionAuthorization';
import { createApiSessionSocketStub, resolveApiSessionSocketDefaultAck } from '@/testkit/backends/apiSessionSocketHarness';
import { MACHINE_SESSION_TERMINAL_CAPTURE_EVENT_V1, MACHINE_SESSION_TERMINAL_FINALIZE_EVENT_V1,
  MachineSessionTerminalCaptureRequestV1Schema, MachineSessionTerminalCaptureResponseV1Schema,
  MachineSessionTerminalFinalizeRequestV1Schema, MachineSessionTerminalFinalizeResponseV1Schema } from '@happier-dev/protocol/sessions/control/machineSessionTerminalV1';

const boundary = vi.hoisted(() => ({ control: null as Parameters<typeof startDaemonControlServer>[0] | null }));
// Only the private OS listener is replaced. Requester opening, settings, CLI
// factory, public Stop service, local registrar and physical Stop remain real.
vi.mock('@/daemon/controlServer', () => ({ startDaemonControlServer: async (input: Parameters<typeof startDaemonControlServer>[0]) => {
  boundary.control = input;
  return { port: 43129, stop: async () => {} };
} }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); boundary.control = null; });

it.each(['explicit_stop', 'lifecycle_control'] as const)('settles one requester Stop through the installed factory with one owner RPC and an exited runner (%s)', async stopIntent => {
  const homeId = 'srv_stop_reentry';
  const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'requester', tokenEpoch: 0,
    provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`, encryption: null };
  const installedCredentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'requester', tokenEpoch: 0,
    provenance: { v: 1, kind: 'terminal', authority: 'account_automation' } })).toString('base64url')}.signature`, encryption: null };
  const h = await createInstalledProjectAgentDaemonFixture(() => boundary.control, undefined, true, undefined, undefined, {
    credentials: installedCredentials, accountActionCredentials: installedCredentials, requesterCredentials: installedCredentials,
    externalActionAccountId: 'requester', ordinaryAccountSession: true, homeServerIdentityId: homeId,
    machineAccess: { custodianAccountId: 'requester', role: 'manage' },
    resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: homeId, machineId: 'machine' }),
  });
  const child = spawn(process.execPath, ['-e', "process.send('ready'); setInterval(() => {}, 1000)"],
    { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const exited = once(child, 'exit');
  onTestFinished(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  });
  await once(child, 'message');
  const identity = await readProcessIdentityByPid(child.pid!);
  if (!identity) throw new Error('Owned runner identity unavailable');
  h.trackedSessionsByKey.clear();
  const tracked = { ...h.tracked, pid: child.pid!, sessionRunnerPid: child.pid!, childProcess: child,
    processStartTimeMs: identity.processStartTimeMs, processCommandHash: hashProcessCommand(identity.command) };
  h.trackedSessionsByKey.set(tracked.trackingKey, tracked);
  h.machine.setRPCHandlers({ spawnSession: async () => { throw new Error('Stop cannot spawn'); },
    stopSession: h.daemon.stopSession, requestShutdown() {} });
  // Home's terminal publisher acknowledgement is the network boundary. The
  // actual exit observer must settle it before retiring the tracked runner.
  Reflect.set(h.machine, 'socket', createApiSessionSocketStub({ connected: true, emitWithAck: (event, payload) => {
    if (event === MACHINE_SESSION_TERMINAL_CAPTURE_EVENT_V1) {
      const request = MachineSessionTerminalCaptureRequestV1Schema.parse(payload);
      return MachineSessionTerminalCaptureResponseV1Schema.parse({ v: 1, status: 'captured', sessionId: request.sessionId,
        authority: { kind: 'generation', publisherGeneration: '1' } });
    }
    if (event === MACHINE_SESSION_TERMINAL_FINALIZE_EVENT_V1) {
      const request = MachineSessionTerminalFinalizeRequestV1Schema.parse(payload);
      return MachineSessionTerminalFinalizeResponseV1Schema.parse({ v: 1, status: 'closed', sessionId: request.sessionId });
    }
    return resolveApiSessionSocketDefaultAck(event, payload);
  } }));
  const fields = buildSessionMetadataEnvelopeFields({ credentials, accountEncryptionMode: 'plain', storedContentMode: 'plain',
    metadata: { machineId: 'machine', path: h.cwd, hostPid: tracked.pid, hostProcessStartTimeMs: tracked.processStartTimeMs }, agentState: null });
  const raw = createSessionRecordFixture({ id: h.sessionId, active: true, encryptionMode: 'plain', metadataLayoutVersion: 1,
    machineId: 'machine', share: null, metadata: fields.sharedMetadata.ciphertext, ownerMetadata: fields.ownerMetadata,
    agentState: fields.agentState });
  const get = vi.mocked(axios.get).getMockImplementation()!;
  const post = vi.mocked(axios.post).getMockImplementation()!;
  const nativeSignatures: string[] = [];
  vi.mocked(axios.get).mockImplementation(async (url, ...args) => {
    if (new URL(String(url)).pathname === `/v2/sessions/${h.sessionId}`) {
      const signature = AxiosHeaders.from(args[0]?.headers).get(EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER);
      // Requester admission also reads the Session; only native effect requests
      // carry the installation signature. Preserve both network responses.
      if (typeof signature === 'string') nativeSignatures.push(signature);
      return { status: 200, data: { session: { ...raw, active: child.exitCode === null && child.signalCode === null } } };
    }
    return get(url, ...args);
  });
  vi.mocked(axios.post).mockImplementation(async (url, ...args) => String(url).endsWith('/execution-authorization/verify')
    ? { status: 200, data: { ok: true } } : post(url, ...args));
  vi.spyOn(axios, 'patch').mockImplementation(async (_url, body) => {
    const patch = SessionMetadataTuplePatchV1Schema.parse(body);
    if (patch.mode !== 'owner') throw new Error('Expected owner metadata');
    raw.metadata = patch.sharedMetadata.ciphertext;
    raw.ownerMetadata = patch.ownerMetadata;
    raw.agentState = patch.agentState.ciphertext;
    raw.metadataVersion = patch.sharedMetadata.expectedVersion + 1;
    raw.agentStateVersion = patch.agentState.expectedVersion + 1;
    return { status: 200, data: SessionMetadataTuplePatchSuccessV1Schema.parse({ success: true, metadataLayoutVersion: 1,
      sharedMetadata: { version: raw.metadataVersion }, agentState: { version: raw.agentStateVersion } }) };
  });
  const requestId = '405a81d1-7a71-4288-85f6-0c72209982e9';
  const input = { sessionId: h.sessionId, stopIntent };
  const target = { kind: 'session' as const, sessionId: h.sessionId };
  const root = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'stop-root', binding: {
    accountId: 'requester', custodianAccountId: 'requester', authentication: { kind: 'account', tokenEpoch: 0 },
    accountEncryptionMode: 'plain', serverIdentityId: homeId, machineId: 'machine', installationId: h.f.installation.installationId,
    actionId: 'session.stop', requestId, target,
    requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1({ v: 1, requestId, target, input }),
  } });
  const purpose = { kind: 'external_action' as const };
  const authorization = sealExternalActionRequesterAccountContextV1({ authorization: root, purpose,
    credentials: encodeStoredCredentials(credentials), invocation: { caller: { kind: 'host' }, surface: 'ui', authority: 'present_user' },
    installationPublicKey: Buffer.from(h.f.installation.publicKey, 'base64url'), randomBytes: nacl.randomBytes });
  const lifetime = new AbortController();
  let ownerEntries = 0;
  let factoryEntries = 0;
  // Count the diagnosed boundary; abort only the test's operation on re-entry.
  // Production has no count cutoff, retry limit or replacement timer.
  const log = logger.warnLocalFile.bind(logger);
  vi.spyOn(logger, 'warnLocalFile').mockImplementation((message, ...args) => {
    const detail = args[0];
    if (message === '[external-action-stage]' && detail && typeof detail === 'object'
      && Reflect.get(detail, 'rootRequestId') === requestId) {
      if (Reflect.get(detail, 'stage') === 'daemon.cli_factory.begin') factoryEntries++;
      if (Reflect.get(detail, 'stage') === 'stop.owner_rpc.begin' && ++ownerEntries > 1) lifetime.abort();
    }
    log(message, ...args);
  });
  let physicalStarted!: () => void;
  const physicalStart = new Promise<void>(resolve => { physicalStarted = resolve; });
  const infoFile = logger.infoFile.bind(logger);
  const diagnostic = vi.spyOn(logger, 'infoFile').mockImplementation((message, ...args) => {
    infoFile(message, ...args);
    const detail = args[0];
    if (message === '[DAEMON STOP] Physical Stop phase started' && detail && typeof detail === 'object'
      && Reflect.get(detail, 'phase') === 'signal_request') physicalStarted();
  });
  const owner = h.daemon.externalActionIngressOwner;
  if (!owner) throw new Error('Installed requester Stop admission unavailable');
  try {
    const pending = executeExternalAction({ ...owner, actionId: 'session.stop',
      envelope: { v: 1, requestId, target, input }, executionAuthorization: authorization,
      principal: { accountId: 'requester', authority: 'present_user', authentication: { kind: 'account', tokenEpoch: 0 } },
      currentMachineId: 'machine', currentAccountId: 'requester', currentInstallationId: h.f.installation.installationId,
      verifyExecutionAuthorization: request => verifyExternalActionExecutionAuthorizationCurrent({ ...request,
        privateKey: h.f.installation.privateKey, installationId: h.f.installation.installationId,
        serverHttpBaseUrl: 'https://session-home.test' }), signal: lifetime.signal });
    await physicalStart;
    const coalesced = h.daemon.stopSession(h.sessionId, {
      source: { surface: 'cli', callerKind: 'host' }, transport: 'local_http',
    });
    const result = await pending;
    expect(await coalesced).toEqual({ status: 'stopped' });
    expect(ownerEntries, JSON.stringify(result)).toBe(1);
    expect(factoryEntries).toBe(1);
    expect(nativeSignatures.length).toBeGreaterThan(0);
    for (const signature of nativeSignatures) expect(verifyExternalActionMachineRequestV1({
      authorizationToken: root.token, effectActionId: 'session.stop', target,
      installationId: h.f.installation.installationId, requestId, method: 'GET',
      path: `/v2/sessions/${h.sessionId}`, signature, publicKey: h.f.installation.publicKey })).toBe(true);
    const hold = readSessionExplicitStopV1FromMetadata(tryDecryptSessionOwnerMetadataView({
      credentials, accountEncryptionMode: 'plain', rawSession: raw }));
    if (stopIntent === 'explicit_stop') expect(hold).toMatchObject({ requestId });
    else expect(hold).toBeNull();
    expect(result, JSON.stringify(result)).toMatchObject({ kind: 'response',
      response: { execution: { ok: true, result: { stopped: true } } } });
    await exited;
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    expect(h.trackedSessionsByKey.has(tracked.trackingKey)).toBe(false);
    for (const event of ['session_stop_received', 'session_stop_attempt']) {
      expect(diagnostic.mock.calls).toContainEqual([expect.any(String), expect.objectContaining({ event,
        sessionId: h.sessionId, requestTransport: 'external_action', requestSource: { surface: 'ui', callerKind: 'host' } })]);
    }
    const receipts = diagnostic.mock.calls.filter(([, detail]) => detail && typeof detail === 'object'
      && Reflect.get(detail, 'event') === 'session_stop_received');
    expect(receipts).toHaveLength(2);
    expect(receipts).toContainEqual([expect.any(String), expect.objectContaining({
      requestTransport: 'local_http', requestSource: { surface: 'cli', callerKind: 'host' },
    })]);
    expect(diagnostic.mock.calls.filter(([, detail]) => detail && typeof detail === 'object'
      && Reflect.get(detail, 'event') === 'session_stop_attempt')).toHaveLength(1);
    const signal = diagnostic.mock.calls.find(([event, detail]) => event === '[DAEMON STOP] Physical Stop phase started'
      && detail && typeof detail === 'object' && Reflect.get(detail, 'phase') === 'signal_request');
    expect(signal?.[1]).toMatchObject({ requestSource: { surface: 'ui', callerKind: 'host' }, requestTransport: 'external_action' });

  } finally { lifetime.abort(); }
});
