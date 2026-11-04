import { afterEach, expect, it, vi } from 'vitest';
import axios from 'axios';
import nacl from 'tweetnacl';

import type { startDaemonControlServer } from '@/daemon/controlServer';
import { createInstalledProjectAgentDaemonFixture, type InstalledProjectAgentDaemonFixture } from '@/daemon/testkit/installedProjectAgentDaemonFixture';
import { createDaemonSessionTeamCredentialNativeRelease } from '@/daemon/providers/sessionTeamCredentialNativeLifetime';
import * as machineTransport from '@/api/machine/connection/createMachineSocketTransport';
import { ManagedMachineV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { SessionTeamCredentialBindingIntentV1Schema } from '@happier-dev/protocol/teams/credentials/sessionBindingIntentV1';
import { TeamCredentialNativeBindingReadRequestV1Schema, computeTeamCredentialNativeBindingReadDigestV1 } from '@happier-dev/protocol/teams/credentials/directMaterialV1';
import { verifyMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { ExternalActionExecutionAuthorizationRequestV1Schema, ExternalActionRequestEnvelopeSchema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { openManagedControllerActionCodecV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { MACHINE_SESSION_TERMINAL_CAPTURE_EVENT_V1, MACHINE_SESSION_TERMINAL_FINALIZE_EVENT_V1, MachineSessionTerminalCaptureRequestV1Schema, MachineSessionTerminalFinalizeRequestV1Schema } from '@happier-dev/protocol/sessions/control/machineSessionTerminalV1';
import { MACHINE_UPDATE_OPERATION_PROTOCOL_CAPABILITIES_EVENT_V1 } from '@happier-dev/protocol/machines/operationProtocolCapabilitiesV1';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';

const listener = vi.hoisted(() => ({ input: null as Parameters<typeof startDaemonControlServer>[0] | null }));
// The control listener is an OS boundary. Home/controller HTTP and the existing
// loopback Socket.IO server are the other boundaries; lifetime owners stay real.
vi.mock('@/daemon/controlServer', async importOriginal => ({
  ...await importOriginal<typeof import('@/daemon/controlServer')>(),
  startDaemonControlServer: async (input: Parameters<typeof startDaemonControlServer>[0]) => {
    listener.input = input;
    return { port: 43129, stop: async () => {} };
  },
}));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); listener.input = null; });

for (const kind of ['normal', 'respawn-terminal'] as const) {
  const phases = kind === 'normal' ? ['confirmed', 'unknown', 'publication-retry', 'prepared-recheck', 'capture-retry'] as const
    : ['confirmed', 'unknown', 'publication-retry', 'prepared-recheck', 'capture-retry', 'permanent-capture', 'permanent-finalize'] as const;
  it.each(phases)(
    `settles ${kind} native lifetime through real Home/controller transports (%s)`, async phase => {
    const homeId = 'srv_native_lifetime';
    const controllerKeys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(77));
    const payload = Buffer.from(JSON.stringify({ sub: 'requester', tokenEpoch: 2,
      provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url');
    const requesterCredentials = { token: `e30.${payload}.signature`, encryption: null };
    let fixture: InstalledProjectAgentDaemonFixture | undefined;
    const releaseNative = createDaemonSessionTeamCredentialNativeRelease({ machineId: 'machine', accountId: 'custodian',
      credentials: { token: 'custodian-token', encryption: null }, serverHttpBaseUrl: 'https://session-home.test',
      readInstallationIdentity: () => fixture?.f.installation ?? null,
      resolveCurrentMachineExecutionOriginContext: async () => ({ machineId: 'machine', serverIdentityId: homeId }),
    });
    const h = fixture = await createInstalledProjectAgentDaemonFixture(() => listener.input, undefined, true, undefined, undefined, {
      homeServerIdentityId: homeId, requesterCredentials,
      processEnv: { HAPPIER_DAEMON_SESSION_RESPAWN_ENABLED: '1' },
      releaseSessionOwnedNativeBindings: releaseNative,
    });
    const nativeDelivery = { managedId: 'managed', controllerInstallationId: 'controller-installation',
      guestInstallationId: h.f.installation.installationId, bindingKey: 'native-binding',
      placeholderRef: 'opaque-placeholder', sourceRevision: 'source', providerTicket: 't'.repeat(43) };
    const binding = SessionTeamCredentialBindingIntentV1Schema.parse({ v: 1, slot: { kind: 'provider_model' },
      resourceId: 'native-resource', teamId: 'team', expectedResourceRevision: 1,
      deliveryMode: 'vendor-native', nativeDelivery });
    const machine = ManagedMachineV1Schema.parse({ id: 'managed', homeId, custodianAccountId: 'company',
      enrollmentAccountId: 'requester', controller: { machineId: 'controller', installationId: 'controller-installation' },
      controllerAccess: { custodian: { accountId: 'company' },
        installationPublicKey: Buffer.from(controllerKeys.publicKey).toString('base64url') },
      enrolledMachineId: 'machine', launch: { provider: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, name: 'guest', choices: {} },
      allocation: 'bound', resource: { contributionRef: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, value: {} },
      creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 0,
      retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false });
    let reads = 0;
    let observeRead!: () => void;
    const readStarted = new Promise<void>(resolve => { observeRead = resolve; });
    let removals = 0;
    let installed = true;
    let prepared = phase === 'prepared-recheck';
    let unknown = phase === 'unknown';
    let finalized = 0;
    let publicationFails = phase === 'publication-retry' || phase === 'prepared-recheck';
    let captureFails = phase === 'capture-retry';
    let releaseRemoval!: () => void;
    const removal = new Promise<void>(resolve => { releaseRemoval = resolve; });
    const previousGet = vi.mocked(axios.get).getMockImplementation();
    const previousPost = vi.mocked(axios.post).getMockImplementation();
    vi.mocked(axios.get).mockImplementation(async (url, options) => {
      if (String(url).endsWith('/v1/account/security')) return { status: 200, data: { v: 1,
        encryptionMode: 'plain', nativeEmail: null, password: { status: 'not_enrolled', revision: null } } };
      if (!previousGet) throw new Error('Missing fixture Home reader');
      return previousGet(url, options);
    });
    vi.mocked(axios.post).mockImplementation(async (url, body, options) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith('/direct-material')) {
        reads++;
        observeRead();
        const { proof, ...request } = TeamCredentialNativeBindingReadRequestV1Schema.parse(body);
        expect(options?.headers?.Authorization).toBe(`Bearer ${requesterCredentials.token}`);
        expect(verifyMachineInstallationProof({ publicKey: h.f.installation.publicKey, proof, payload: {
          version: 1, accountId: 'requester', machineId: 'machine', installationId: h.f.installation.installationId,
          nativeCredentialBindingRead: { requestBodyDigest: computeTeamCredentialNativeBindingReadDigestV1(request) },
        } })).toBe(true);
        return { status: 200, data: prepared ? { status: 'prepared', binding: nativeDelivery }
          : { status: 'unavailable', reason: 'binding_unavailable' } };
      }
      if (path.endsWith('/get')) return { status: 200, data: machine };
      if (path.endsWith('/v1/actions/machines.managed.credentials.install')) {
        removals++;
        expect(h.tracked.requesterSessionRuntimeContext).toBeUndefined();
        expect(await h.requester.isCurrent()).toBe(false);
        expect(options?.headers?.Authorization).toBe(`Bearer ${requesterCredentials.token}`);
        const carrier = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
        const authorization = carrier.executionAuthorization;
        if (!authorization) throw new Error('Missing lifetime Action authorization');
        expect(authorization.binding.accountId).toBe('requester');
        expect(authorization.binding.nativeCredentialSpawnChild).toBeUndefined();
        expect(openManagedControllerActionCodecV1({ authorization, machineId: 'controller', installationId: 'controller-installation',
          serverIdentityId: homeId, installationPrivateKey: controllerKeys.secretKey })).not.toBeNull();
        if (carrier.envelope.v !== 1) throw new Error('Plain lifetime must not fabricate Account encryption');
        expect(carrier.envelope.input).toMatchObject({ sessionId: h.sessionId, bindingKey: nativeDelivery.bindingKey, operation: 'release' });
        await removal;
        if (!unknown) installed = false;
        return { status: 200, data: { v: 1, actionId: authorization.binding.actionId, requestId: authorization.binding.requestId,
          execution: { ok: true, result: unknown ? { kind: 'unknown', code: 'action_outcome_unknown' }
            : { kind: 'confirmed', binding: nativeDelivery } } } };
      }
      if (path.endsWith('/execution-authorization')) {
        expect(options?.headers?.Authorization).toBe(`Bearer ${requesterCredentials.token}`);
        const envelope = ExternalActionRequestEnvelopeSchema.parse(Reflect.get(body as object, 'envelope'));
        if (envelope.v !== 1) throw new Error('Expected plain lifetime envelope');
        expect(body).not.toHaveProperty('nativeCredentialSpawnChild');
        return { status: 200, data: { v: 1, token: 'native-lifetime', binding: {
          serverIdentityId: homeId, accountId: 'requester', authentication: { kind: 'account', tokenEpoch: 2 },
          actionId: 'machines.managed.credentials.install', requestId: envelope.requestId,
          requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), machineId: 'controller',
          installationId: 'controller-installation', custodianAccountId: 'company', target: { kind: 'machine', machineId: 'controller' },
          accountEncryptionMode: 'plain', managedAdmission: { actionId: 'machines.managed.credentials.install', input: envelope.input },
        } } };
      }
      if (!previousPost) throw new Error('Missing fixture Home writer');
      return previousPost(url, body, options);
    });
    h.f.channel.server.on('connection', socket => {
      if (socket.handshake.auth.clientType !== 'machine-scoped') return;
      socket.on(SOCKET_RPC_EVENTS.REGISTER, (request: unknown) => socket.emit(SOCKET_RPC_EVENTS.REGISTERED, request));
      socket.on(MACHINE_UPDATE_OPERATION_PROTOCOL_CAPABILITIES_EVENT_V1, (_request: unknown, ack: (value: unknown) => void) => {
        ack({ v: 1, result: 'success', revision: 1 });
      });
      socket.on(MACHINE_SESSION_TERMINAL_CAPTURE_EVENT_V1, (raw: unknown, ack: (value: unknown) => void) => {
        const request = MachineSessionTerminalCaptureRequestV1Schema.parse(raw);
        ack(phase === 'permanent-capture' ? { v: 1, status: 'rejected', sessionId: request.sessionId, reason: 'not_found' }
          : captureFails ? { v: 1, status: 'rejected', sessionId: request.sessionId, reason: 'internal_error' }
          : { v: 1, status: 'captured', sessionId: request.sessionId, authority: { kind: 'generation', publisherGeneration: '1' } });
      });
      socket.on(MACHINE_SESSION_TERMINAL_FINALIZE_EVENT_V1, (raw: unknown, ack: (value: unknown) => void) => {
        const request = MachineSessionTerminalFinalizeRequestV1Schema.parse(raw);
        finalized++;
        ack(phase === 'permanent-finalize' ? { v: 1, status: 'rejected', sessionId: request.sessionId, reason: 'not_found' }
          : publicationFails ? { v: 1, status: 'rejected', sessionId: request.sessionId, reason: 'internal_error' }
          : { v: 1, status: 'closed', sessionId: request.sessionId });
      });
    });
    const address = h.f.channel.server.httpServer.address();
    if (!address || typeof address === 'string') throw new Error('Missing loopback Home address');
    const createMachineTransport = machineTransport.createMachineSocketTransport;
    vi.spyOn(machineTransport, 'createMachineSocketTransport').mockImplementation(options => createMachineTransport({
      ...options, serverUrl: `http://127.0.0.1:${address.port}`, transports: ['websocket'],
    }));
    h.machine.connect();
    await vi.waitFor(() => expect([...h.f.channel.server.sockets.sockets.values()]
      .some(socket => socket.handshake.auth.clientType === 'machine-scoped')).toBe(true));
    const tracked = h.tracked;
    h.pidToTrackedSession.delete(tracked.pid);
    tracked.pid = 2147482911;
    tracked.sessionRunnerPid = tracked.pid;
    delete tracked.projectSetupOperation;
    tracked.spawnOptions = { ...(tracked.spawnOptions ?? { directory: h.cwd }), teamCredentialBindings: [binding] };
    if (kind === 'respawn-terminal') tracked.spawnOptions.directory = '';
    tracked.requesterSessionRuntimeContext = h.requester;
    h.pidToTrackedSession.set(tracked.pid, tracked);
    const exit = { reason: 'process-exited', code: kind === 'normal' ? 0 : 1, signal: null };
    let shutdown: Promise<void> | undefined;
    let exited = false;
    const exiting = h.daemon.onChildExited(tracked.pid, exit).then(() => { exited = true; });
    void exiting.catch(() => {});
    try {
      // Real process-census/owner retirement precedes the HTTP boundary. Wait
      // on that event rather than imposing vi.waitFor's one-second budget.
      await Promise.race([readStarted, exiting.then(() => { throw new Error('exit_settled_before_native_read'); })]);
      expect(reads).toBeGreaterThan(0);
      if (!prepared) {
        await vi.waitFor(() => expect(removals).toBe(1));
        expect(finalized).toBe(0);
        expect(exited).toBe(false);
      }
      if (phase === 'confirmed') {
        let drained = false;
        shutdown = h.daemon.stopControlServer().then(() => { drained = true; });
        await Promise.resolve();
        expect(drained).toBe(false);
        releaseRemoval();
        await exiting;
        await shutdown;
        expect(drained).toBe(true);
      } else if (phase === 'unknown') {
        releaseRemoval();
        await expect(exiting).rejects.toMatchObject({ code: 'action_outcome_unknown' });
        expect(h.pidToTrackedSession.get(tracked.pid)).toBe(tracked);
        expect(finalized).toBe(0);
        await expect(h.daemon.stopControlServer()).rejects.toMatchObject({ code: 'action_outcome_unknown' });
        unknown = false;
        await h.daemon.onChildExited(tracked.pid, exit);
        expect(removals).toBe(2);
      } else if (phase === 'permanent-capture' || phase === 'permanent-finalize') {
        releaseRemoval();
        await exiting;
      } else {
        releaseRemoval();
        if (kind === 'respawn-terminal') await expect(exiting).rejects.toThrow('native_session_terminal_publication_pending');
        else await exiting;
        expect(h.pidToTrackedSession.get(tracked.pid)).toBe(tracked);
        publicationFails = false;
        captureFails = false;
        prepared = false;
        await h.daemon.onChildExited(tracked.pid, exit);
        // Prepared absence is not a permanent cleanup proof, whereas an
        // actually confirmed removal must not be applied again on publish retry.
        expect(removals).toBe(1);
      }
      expect(installed).toBe(false);
      if (phase === 'permanent-capture') expect(finalized).toBe(0);
      else expect(finalized).toBeGreaterThan(0);
      expect(h.pidToTrackedSession.has(tracked.pid)).toBe(false);
    } finally {
      releaseRemoval();
      unknown = false;
      publicationFails = false;
      captureFails = false;
      prepared = false;
      await exiting.catch(() => {});
      if (h.pidToTrackedSession.has(tracked.pid)) await h.daemon.onChildExited(tracked.pid, exit);
      await shutdown;
      await h.daemon.stopControlServer();
      h.machine.shutdown();
    }
  });
}
