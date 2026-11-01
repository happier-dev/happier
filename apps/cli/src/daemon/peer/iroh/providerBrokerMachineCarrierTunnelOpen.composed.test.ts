import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { createServer, request as requestHttp } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import tweetnacl from 'tweetnacl';

import {
  createProviderBrokerRouteGrantSigningInputV1,
  type ProviderBrokerOpenResponseV1,
  type ProviderBrokerRouteGrantPayloadV1,
  type SignedProviderBrokerRouteGrantV1,
} from '@happier-dev/protocol';
import { createProviderBrokerMachineCarrierTunnelOpen } from './providerBrokerMachineCarrierTunnelOpen';
import type { DaemonMachineIrohRuntime } from './daemonMachineIrohRuntime';
import { PROVIDER_BROKER_PRIVATE_CLOSE_PATH } from '@/providers/broker/providerBrokerPrivateProtocol';
import { registerPidSpawnResourceCleanup, retireUpstreamAuthorityBeforeProcessStop } from '@/daemon/sessions/cleanupPidSessionResources';
import { createStopSession } from '@/daemon/sessions/stopSession';
import { createOnChildExited } from '@/daemon/sessions/onChildExited';
import { createDaemonControlApp } from '@/daemon/controlServer';
import { withConfiguredDaemonTestHome } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import type { TrackedSession } from '@/daemon/types';
import { readProcessIdentityByPid } from '@/daemon/processIdentity';
import { hashProcessCommand } from '@/daemon/sessionRegistry';
import { logger } from '@/ui/logger';
import { createDaemonMachineIrohRuntime } from './daemonMachineIrohRuntime';
import { IrohNativeOperationError, type IrohNodeStartMachineHttpTunnelRequest } from '@happier-dev/iroh-native/node';
import { createSessionTurnLifecycle } from '@/agent/runtime/session/turn/lifecycle';
import type { SessionTurnMutationV1 } from '@happier-dev/protocol';
import { presentSessionTeamCredentialDenial } from '../../../../../ui/sources/components/sessions/presentation/sessionTeamCredentialDenialPresentation';
import { createSessionBrokerApplicationEvidence } from '@/providers/broker/sessionBrokerApplicationEvidence';
import { PROVIDER_ENDPOINT_SAFETY_LIMITS } from '@happier-dev/protocol/providers/safety/limits';

const key = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));
const root = { keyId: 'home', publicKey: Buffer.from(key.publicKey).toString('base64url') };
const initiatorEndpoint = 'a'.repeat(64);
const targetEndpoint = 'b'.repeat(64);

function authority(overrides: Partial<ProviderBrokerRouteGrantPayloadV1> = {}): SignedProviderBrokerRouteGrantV1 {
  const payload: ProviderBrokerRouteGrantPayloadV1 = {
    v: 1,
    grantId: 'grant-1',
    aud: 'happier-provider-broker-route-v1',
    issuedAt: 100,
    expiresAt: 10_000,
    teamId: 'team-1',
    resourceId: 'resource-1',
    sourceRevision: 'source-revision-7',
    brokerPlacementFingerprint: 'c'.repeat(64),
    initiatorTokenEpoch: 0,
    initiator: { accountId: 'account-worker', machineId: 'machine-worker', endpointId: initiatorEndpoint },
    target: { custodianAccountId: 'account-custodian', machineId: 'machine-broker', endpointId: targetEndpoint },
    consumer: { kind: 'session', sessionId: 'session-1' },
    application: {
      agentTargetKey: 'codex',
      implementationIdentity: { pluginId: 'happier.provider.cliproxyapi', localId: 'cliproxyapi' },
      endpointTemplateId: 'cliproxyapi-openai-responses',
      protocol: 'openai-responses',
    },
    ...overrides,
  };
  return {
    payload,
    signature: {
      alg: 'Ed25519',
      keyId: 'home',
      valueBase64Url: Buffer.from(tweetnacl.sign.detached(
        Buffer.from(createProviderBrokerRouteGrantSigningInputV1(payload)),
        key.secretKey,
      )).toString('base64url'),
    },
  };
}

function brokerOpen(
  signed: SignedProviderBrokerRouteGrantV1 = authority(),
  targetOverrides: Partial<Extract<ProviderBrokerOpenResponseV1, { ok: true }>['target']> = {},
): Extract<ProviderBrokerOpenResponseV1, { ok: true }> {
  return {
    ok: true,
    authority: signed,
    target: {
      custodianAccountId: signed.payload.target.custodianAccountId,
      brokerMachineId: signed.payload.target.machineId,
      endpointId: signed.payload.target.endpointId,
      endpointRevision: 7,
      endpoint: {
        endpointId: targetOverrides.endpointId ?? signed.payload.target.endpointId,
        directAddresses: ['10.0.0.2:7777'],
        relayUrls: ['https://target-relay.example.test/'],
      },
      ...targetOverrides,
    },
  };
}

describe('createProviderBrokerMachineCarrierTunnelOpen', () => {
  it('abandons a pending dial at the existing endpoint budget and closes a late tunnel without redial', async () => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    const diagnostics = vi.spyOn(logger, 'infoFile').mockImplementation(() => {});
    const lateClose = vi.fn(async () => {});
    let completeDial!: (tunnel: Awaited<ReturnType<DaemonMachineIrohRuntime['openHttpTunnel']>>) => void;
    const pending = new Promise<Awaited<ReturnType<DaemonMachineIrohRuntime['openHttpTunnel']>>>(resolve => { completeDial = resolve; });
    let started!: () => void;
    const dialStarted = new Promise<void>(resolve => { started = resolve; });
    let opens = 0;
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    try {
      const tunnel = await createProviderBrokerMachineCarrierTunnelOpen({ accountId: 'account-worker', localMachineId: 'machine-worker',
        resolveTrustRoots: () => [root], nowMs: () => 200, fetchImpl,
        runtime: { endpoint: { endpointId: initiatorEndpoint }, openHttpTunnel: async () => {
          if (opens++ > 0) { started(); return pending; }
          return { localPort: 41001, localCapability: 'c'.repeat(64), remoteEndpointId: targetEndpoint, observedPath: 'direct', close: async () => {} };
        } },
      })({ brokerOpen: brokerOpen() });
      const retirement = tunnel.retire();
      await dialStarted;
      expect(timeout.mock.calls).toEqual([[PROVIDER_ENDPOINT_SAFETY_LIMITS.maxWallTimeMs]]);
      controller.abort(new DOMException('Endpoint budget expired', 'TimeoutError'));
      await expect(retirement).resolves.toBeUndefined();
      await tunnel.retire();
      expect(diagnostics.mock.calls).toContainEqual(['[provider-broker-release]', expect.objectContaining({
        outcome: 'abandoned', reasonCode: 'release_budget_expired', phase: 'private_control_dial',
      })]);
      completeDial({ localPort: 41002, localCapability: 'd'.repeat(64), remoteEndpointId: targetEndpoint, observedPath: 'direct', close: lateClose });
      await pending;
      await vi.waitFor(() => expect(lateClose).toHaveBeenCalledOnce());
      expect(opens).toBe(2);
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally { timeout.mockRestore(); diagnostics.mockRestore(); }
  });

  it.each((['released', 'target_gone', 'abandoned'] as const).flatMap(outcome =>
    (['session', 'daemon'] as const).map(surface => ({ outcome, surface }))))(
    'settles $outcome once through $surface Stop', async ({ outcome, surface }) => {
      await withConfiguredDaemonTestHome({ prefix: 'broker-release-stop-' }, async () => {
        const diagnostics = vi.spyOn(logger, 'infoFile').mockImplementation(() => {});
        const child = spawn(process.execPath, ['-e', "process.send('ready'); setInterval(() => {}, 1000)"],
          { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
        const exited = once(child, 'exit');
        let opens = 0;
        let deletes = 0;
        let withdrawn = false;
        const open = createProviderBrokerMachineCarrierTunnelOpen({
          accountId: 'account-worker', localMachineId: 'machine-worker', resolveTrustRoots: () => [root], nowMs: () => 200,
          // Native transport and HTTP are system boundaries; the cleanup/Stop
          // owners below are real, including the refusal gate and exit settlement.
          runtime: { endpoint: { endpointId: initiatorEndpoint }, openHttpTunnel: async () => {
            const control = opens++ > 0;
            if (control) {
              expect(withdrawn).toBe(true);
              if (outcome === 'abandoned') throw new DOMException('Dial timed out', 'TimeoutError');
              if (outcome === 'target_gone') throw new IrohNativeOperationError('endpoint-identity-mismatch', 'Authenticated endpoint changed');
            }
            return { localPort: control ? 41002 : 41001, localCapability: 'c'.repeat(64), observedPath: 'direct',
              remoteEndpointId: targetEndpoint,
              close: async () => { if (!control) withdrawn = true; } };
          } },
          fetchImpl: async () => { deletes++; return new Response(null, { status: 204 }); },
        });
        let app: ReturnType<typeof createDaemonControlApp> | undefined;
        try {
          await once(child, 'message');
          const pid = child.pid!;
          const identity = await readProcessIdentityByPid(pid);
          if (!identity) throw new Error('Missing owned test process identity');
          const tracked: TrackedSession = { pid, childProcess: child, happySessionId: 'session-1', startedBy: 'daemon',
            processStartTimeMs: identity.processStartTimeMs, processCommandHash: hashProcessCommand(identity.command) };
          const sessions = new Map([[pid, tracked]]);
          const cleanups = new Map<number, () => void | Promise<void>>();
          const tunnel = await open({ brokerOpen: brokerOpen() });
          registerPidSpawnResourceCleanup({ pid, label: 'provider_broker.binding.open', spawnResourceCleanupByPid: cleanups,
            isCurrentPidOwner: () => sessions.get(pid) === tracked, cleanup: tunnel.retire });
          const retainedCleanup = cleanups.get(pid)!;
          const onExit = createOnChildExited({ pidToTrackedSession: sessions, spawnResourceCleanupByPid: cleanups,
            sessionAttachCleanupByPid: new Map(), removeSessionMarkerFn: async () => {},
            getApiMachineForSessions: () => ({ captureMachineSessionTerminal: async () => {
              return { v: 1, status: 'already_inactive', sessionId: 'session-1' };
            }, finalizeMachineSessionTerminal: async () => { throw new Error('Already-inactive fixture needs no finalization'); },
              enqueueDaemonTerminalExactTurnEnd: async () => { throw new Error('Fixture has no active turn'); },
            }) });
          const stop = createStopSession({ pidToTrackedSession: sessions,
            readHostAttachmentState: async () => ({ status: 'absent' }), readTerminalAttachmentInfo: async () => null,
            areTrackedRunnersExited: async () => child.exitCode !== null || child.signalCode !== null,
            retireUpstreamAuthorityBeforeProcessStop: pid => retireUpstreamAuthorityBeforeProcessStop({ pid, spawnResourceCleanupByPid: cleanups }),
            waitForTrackedRunnersExit: async () => {
              const [code, signal] = await exited;
              await onExit(pid, { reason: 'process-exited', code, signal });
              return !sessions.has(pid);
            },
          });
          if (surface === 'session') {
            // The real refusal gate must settle before signalling this live child.
            expect(await stop('session-1')).toEqual({ status: 'stopped' });
          } else {
            // Reproduce retained cleanup after a runner already exited: an
            // earlier release must settle and never redial during daemon stop.
            child.kill('SIGTERM');
            await exited;
            await retainedCleanup();
            const shutdown = new Promise<void>(resolve => {
              app = createDaemonControlApp({ getChildren: () => [...sessions.values()], machineId: 'machine-worker',
                stopSession: sessionId => stop(sessionId), spawnSession: async () => ({ type: 'success', sessionId: 'unused' }),
                requestShutdown: resolve, onHappySessionWebhook: () => {}, controlToken: 'fixture-control' });
            });
            const response = await app!.inject({ method: 'POST', url: '/stop', payload: { stopSessions: true },
              headers: { 'x-happier-daemon-token': 'fixture-control' } });
            expect(response.json()).toEqual({ status: 'stopping' });
            await shutdown;
          }
          expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
          expect(cleanups.size).toBe(0);
          const terminal = diagnostics.mock.calls.filter(([label, record]) => label === '[provider-broker-release]'
            && record && typeof record === 'object' && 'outcome' in record);
          expect(terminal).toEqual([['[provider-broker-release]', expect.objectContaining({ outcome,
            targetMachineId: 'machine-broker', requestId: expect.stringMatching(/^[0-9a-f-]{36}$/u), reasonCode: expect.any(String) })]]);
          expect(sessions.size).toBe(0);
          await Promise.all([tunnel.retire(), tunnel.retire(), retainedCleanup()]);
          expect(opens).toBe(2); // Later stop/cleanup attempts perform no new dial.
          expect(deletes).toBe(outcome === 'released' ? 1 : 0);
        } finally {
          await app?.close();
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
          await exited;
          diagnostics.mockRestore();
        }
      });
    },
  );

  it.each([
    { failure: { ok: false as const, reasonCode: 'resource_forbidden' as const }, nativeRefusal: 'socket_close' },
    { failure: { ok: false as const, reasonCode: 'resource_forbidden' as const }, nativeRefusal: 'http_403' },
    { failure: { ok: false as const, reasonCode: 'broker_unavailable' as const }, nativeRefusal: 'http_403' },
    { failure: { ok: false as const, reasonCode: 'team_credential_usage_limit' as const,
      usageLimit: { metric: 'total_tokens' as const, remaining: '0', resetsAtUtc: '2026-10-24T00:00:00.000Z' } }, nativeRefusal: 'http_403' },
  ])('carries a later Home refusal through native admission into the existing Session denial surface ($failure.reasonCode, $nativeRefusal)', async ({ failure, nativeRefusal }) => {
    let request: IrohNodeStartMachineHttpTunnelRequest | undefined;
    // The native addon's c149 boundary either closes the socket (older builds)
    // or frames the callback's refusal as HTTP 403. Host evidence owns both.
    const listener = createServer(async (incoming, response) => {
      if (!request?.handshakeProvider) throw new Error('Missing native admission callback');
      const handshake = JSON.parse(await request.handshakeProvider());
      if (nativeRefusal === 'socket_close') incoming.socket.destroy();
      else response.writeHead(403).end(handshake.responseBody);
    });
    await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
    onTestFinished(() => new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve())));
    const address = listener.address();
    if (!address || typeof address === 'string') throw new Error('Missing native listener');
    const runtime = await createDaemonMachineIrohRuntime({
      happyHomeDir: '/daemon-home', relayConfig: { relayPolicy: 'disabled', relayUrls: [] },
      // The native addon is the OS/transport boundary; both carrier owners remain real.
      native: {
        createEndpoint: async () => ({ endpointHandle: 'endpoint-1', endpointId: initiatorEndpoint }),
        getEndpointStatus: async () => ({ endpointHandle: 'endpoint-1', endpointId: initiatorEndpoint,
          directAddresses: [], relayUrls: [], capProfile: 'machineBulk', active: true }),
        startMachineHttpTunnel: async (input: IrohNodeStartMachineHttpTunnelRequest) => {
          request = input;
          return { machineTunnelId: 'tunnel-1', endpointHandle: 'endpoint-1', localPort: address.port,
            localCapability: 'c'.repeat(64), connectionActive: true, remoteEndpointId: targetEndpoint,
            observedPath: 'direct', startedAtMs: 1, lastErrorCode: null };
        },
        stopMachineTunnel: async () => {}, shutdownEndpoint: async () => {},
      } as never,
    });
    if (!runtime.available) throw new Error('Expected native endpoint');
    let refreshes = 0;
    let refused = false;
    let boundaryFailure: Error | undefined;
    let activeTurnId: string | null = 'refused-turn';
    const evidence = createSessionBrokerApplicationEvidence({ sessionId: 'session-1', pid: process.pid,
      readActiveTurnId: () => activeTurnId, isCurrent: () => true });
    const mutations: SessionTurnMutationV1[] = [];
    let evidenceReads = 0;
    const lifecycle = createSessionTurnLifecycle({
      session: { sessionId: 'session-1', enqueueSessionTurnMutation: async mutation => { mutations.push(mutation); } },
      readTeamCredentialDenial: async turnId => { evidenceReads++; return evidence.readDenial(turnId); },
    });
    let sequence = 0;
    const fail = async (turnId: string, cancelled = false) => {
      activeTurnId = turnId;
      lifecycle.observeRuntimeEvent({ sequence: sequence++, sessionId: 'session-1', emittedAtMs: 200,
        kind: 'turn-start', turnId, startedBy: 'host' });
      lifecycle.observeRuntimeEvent(cancelled
        ? { sequence: sequence++, sessionId: 'session-1', emittedAtMs: 201, kind: 'turn-cancelled', turnId, cause: 'user' }
        : { sequence: sequence++, sessionId: 'session-1', emittedAtMs: 201, kind: 'turn-failed', turnId,
          diagnostic: { code: 'codex_app_server_turn_failed', severity: 'error', message: 'Codex app-server turn failed.',
            details: { v: 1, source: 'agent_session_error' } } });
      await lifecycle.drainAcceptedLifecycle();
    };
    const open = createProviderBrokerMachineCarrierTunnelOpen({
      accountId: 'account-worker', localMachineId: 'machine-worker', runtime,
      resolveTrustRoots: () => [root], nowMs: () => 200,
      beginSessionApplicationRequest: () => evidence.beginRequest(),
    });
    const tunnel = await open({ brokerOpen: brokerOpen(), refreshBrokerOpen: async () => {
      refreshes++;
      if (boundaryFailure) throw boundaryFailure;
      return refused ? failure : brokerOpen();
    } });
    try {
      if (!request?.handshakeProvider) throw new Error('Expected native admission callback');
      expect(JSON.parse(await request.handshakeProvider())).toMatchObject({ kind: 'provider_broker' });
      refused = true;
      const nativeResponse = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const connection = requestHttp(`http://127.0.0.1:${address.port}`, { agent: false }, response => {
          const chunks: Buffer[] = [];
          response.on('data', chunk => chunks.push(Buffer.from(chunk)));
          response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
          response.on('error', reject);
        });
        connection.on('error', reject);
        connection.end();
      }).catch((error: unknown) => {
        expect(error).toMatchObject({ code: 'ECONNRESET' });
        return null;
      });
      if (nativeRefusal === 'socket_close') expect(nativeResponse).toBeNull();
      else {
        expect(nativeResponse?.status).toBe(403);
        expect(JSON.parse(nativeResponse!.body).error).toMatchObject({ type: 'permission_error',
          code: failure.reasonCode, resourceId: 'resource-1' });
      }
      // The host retains its own admitted evidence. The native Agent may discard
      // every byte of the Provider body and emit only its generic diagnostic.
      await fail('refused-turn');
      const failed = mutations.find(mutation => mutation.action === 'fail');
      expect(failed).toMatchObject({ issue: { source: 'team_credential',
        teamCredential: { reasonCode: failure.reasonCode, resourceId: 'resource-1',
          ...('usageLimit' in failure ? { usageLimit: failure.usageLimit } : {}) } } });
      if (failed?.action !== 'fail') throw new Error('Expected failed turn');
      expect(presentSessionTeamCredentialDenial({ issue: failed.issue,
        resolveResourceDisplayName: () => 'Acme OpenAI' })).toMatchObject({ resourceId: 'resource-1', action: 'choose-model',
          body: expect.stringContaining('Acme OpenAI') });
      expect(JSON.stringify(failed.issue)).not.toMatch(/permission_error|valueBase64Url|private-capability/u);
      await fail('cancelled-turn', true);
      expect(mutations.at(-1)?.action).toBe('cancel');
      expect(evidenceReads).toBe(1); // Cancellation performs no broker evidence request.
      refused = false;
      expect(JSON.parse(await request.handshakeProvider())).toMatchObject({ kind: 'provider_broker' });
      await fail('ordinary-failure');
      expect(mutations.at(-1)).toMatchObject({ action: 'fail', issue: { source: 'agent_session_error' } });
      expect(evidenceReads).toBe(2); // One exact read per failure, never per runtime arrival.
      boundaryFailure = new Error('private boundary failure');
      await expect(request.handshakeProvider()).rejects.toBe(boundaryFailure);
      expect(refreshes).toBe(4); // One Home read per demand; no refusal retries/probes.
    } finally {
      await tunnel.close();
      await runtime.shutdown();
    }
  });

  it('keeps fresh-stream success quiet and records each closed refusal without disclosing authority or errors', async () => {
    const diagnostics = vi.spyOn(logger, 'infoFile').mockImplementation(() => {});
    let transport: Parameters<DaemonMachineIrohRuntime['openHttpTunnel']>[0] | undefined;
    let refused = false;
    let refreshFailure: Error | undefined;
    let refreshes = 0;
    const open = createProviderBrokerMachineCarrierTunnelOpen({
      accountId: 'account-worker', localMachineId: 'machine-worker', resolveTrustRoots: () => [root], nowMs: () => 200,
      runtime: { endpoint: { endpointId: initiatorEndpoint }, openHttpTunnel: async input => {
        transport = input;
        return { localPort: 41001, localCapability: 'private-capability', remoteEndpointId: targetEndpoint,
          observedPath: 'direct', close: async () => {} };
      } },
    });
    try {
      await open({ brokerOpen: brokerOpen(), refreshBrokerOpen: async () => {
        refreshes++;
        if (refreshFailure) throw refreshFailure;
        return refused ? { ok: false, reasonCode: 'session_not_active' }
          : brokerOpen(authority({ grantId: '09df506c-86a6-4569-a4dd-5c3256e0d152' }));
      } });
      await transport?.handshakeProvider?.();
      expect(diagnostics.mock.calls.filter(([label]) => label === '[provider-broker-application]')).toHaveLength(0);
      refused = true;
      await expect(transport?.handshakeProvider?.()).rejects.toMatchObject({ code: 'session_not_active' });
      expect(diagnostics.mock.calls).toContainEqual(['[provider-broker-application]', expect.objectContaining({
        stage: 'carrier_admission', outcome: 'refused', code: 'session_not_active', consumerId: 'session-1',
      })]);
      expect(diagnostics.mock.calls.filter(([, record]) => record && typeof record === 'object'
        && 'stage' in record && record.stage === 'evidence_capture')).toEqual([
        ['[provider-broker-application]', { stage: 'evidence_capture', sessionId: 'session-1',
          turnId: null, pid: process.pid, outcome: 'skipped', reason: 'session_not_bound' }],
      ]);
      refreshFailure = Object.assign(new Error('private error sentinel'), { code: 'private code sentinel' });
      await expect(transport?.handshakeProvider?.()).rejects.toBe(refreshFailure);
      expect(diagnostics.mock.calls).toContainEqual(['[provider-broker-application]', expect.objectContaining({
        stage: 'carrier_admission', outcome: 'failed', code: 'transport_error',
      })]);
      expect(diagnostics.mock.calls.filter(([, record]) => record && typeof record === 'object'
        && 'stage' in record && record.stage === 'carrier_admission')).toHaveLength(2);
      expect(refreshes).toBe(3); // One fresh Home check per demand, with no diagnostic probes/retries.
      expect(JSON.stringify(diagnostics.mock.calls)).not.toMatch(/private-capability|valueBase64Url|source-revision|private error sentinel|private code sentinel/u);
    } finally {
      diagnostics.mockRestore();
    }
  });

  it.each(['public_listener_withdrawal', 'private_control_dial', 'delete_dispatched', 'response_received'] as const)(
    'retains %s attribution and the original failure through registered Session cleanup', async phase => {
      const diagnostics = vi.spyOn(logger, 'debug').mockImplementation(() => {});
      const original = new Error('native or HTTP boundary failure');
      let opens = 0;
      let sentRequestId: string | null = null;
      const openHttpTunnel: DaemonMachineIrohRuntime['openHttpTunnel'] = async () => {
        const control = opens++ > 0;
        if (control && phase === 'private_control_dial') throw original;
        return { localPort: control ? 41002 : 41001, localCapability: 'c'.repeat(64),
          remoteEndpointId: targetEndpoint, observedPath: 'direct', close: async () => {
            if (!control && phase === 'public_listener_withdrawal') throw original;
          } };
      };
      const open = createProviderBrokerMachineCarrierTunnelOpen({
        accountId: 'account-worker', localMachineId: 'machine-worker',
        runtime: { endpoint: { endpointId: initiatorEndpoint }, openHttpTunnel },
        resolveTrustRoots: () => [root], nowMs: () => 200,
        fetchImpl: async (_url, init) => {
          sentRequestId = new Headers(init?.headers).get('x-happier-provider-broker-close-request-id');
          if (phase === 'delete_dispatched') throw original;
          return new Response(null, { status: 503 });
        },
      });
      const tunnel = await open({ brokerOpen: brokerOpen() });
      const cleanups = new Map<number, () => void | Promise<void>>();
      registerPidSpawnResourceCleanup({ pid: 42, label: 'provider_broker.binding.open',
        spawnResourceCleanupByPid: cleanups, isCurrentPidOwner: () => true, cleanup: tunnel.retire });
      const failure = await Promise.resolve(cleanups.get(42)!()).then(() => null, (error: unknown) => error);
      // Local withdrawal still refuses stop; remote failure settles and retains
      // N3's structured original exception in the file diagnostic instead.
      const releaseFailure = phase === 'public_listener_withdrawal'
        ? failure && typeof failure === 'object' && 'cause' in failure ? failure.cause : undefined
        : diagnostics.mock.calls.find(([label]) => label === '[provider-broker-release] Boundary failure')?.[1];
      expect(failure === null).toBe(phase !== 'public_listener_withdrawal');
      expect(releaseFailure).toMatchObject({ cause: {
        phase, targetMachineId: 'machine-broker', requestId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
        error: phase === 'response_received' ? expect.objectContaining({ code: 'broker_close_rejected' }) : original,
      } });
      if (phase === 'delete_dispatched' || phase === 'response_received') {
        expect(releaseFailure).toMatchObject({ cause: { requestId: sentRequestId } });
      }
      diagnostics.mockRestore();
    },
  );

  it.each([
    { consumer: { kind: 'session' as const, sessionId: 'session-1' } },
    { consumer: { kind: 'execution_run' as const, executionRunId: 'run-1' }, executionRunOccurrenceId: 'run-occurrence-1' },
  ])('uses the complete Home-signed cross-Account target without broad Machine-read authority ($consumer.kind)', async (consumerBinding) => {
    const close = vi.fn(async () => undefined);
    const openHttpTunnel = vi.fn<DaemonMachineIrohRuntime['openHttpTunnel']>(async () => ({
      localPort: 41_001,
      localCapability: 'c'.repeat(64),
      remoteEndpointId: targetEndpoint,
      observedPath: 'relay' as const,
      close,
    }));
    const open = createProviderBrokerMachineCarrierTunnelOpen({
      accountId: 'account-worker',
      localMachineId: 'machine-worker',
      runtime: { endpoint: { endpointId: initiatorEndpoint }, openHttpTunnel } as never,
      resolveTrustRoots: () => [root],
      nowMs: () => 200,
    });

    const opened = brokerOpen(authority(consumerBinding));
    const refreshBrokerOpen = vi.fn(async () => brokerOpen(authority({ ...consumerBinding, grantId: 'grant-2' })));

    openHttpTunnel.mockImplementation(async () => {
      expect(refreshBrokerOpen).toHaveBeenCalledOnce();
      return { localPort: 41_001, localCapability: 'c'.repeat(64), remoteEndpointId: targetEndpoint,
        observedPath: 'relay', close };
    });


    await expect(open({ brokerOpen: opened, refreshBrokerOpen })).resolves.toMatchObject({
      localPort: 41_001,
      localCapability: 'c'.repeat(64),
      observedPath: 'relay',
    });
    expect(openHttpTunnel).toHaveBeenCalledWith(expect.objectContaining({
      flow: 'provider_broker',
      remoteEndpointId: targetEndpoint,
      handshake: { v: 1, kind: 'provider_broker', authority: expect.any(Object) },
    }), opened.target.endpoint);
    const transport = openHttpTunnel.mock.calls[0]?.[0];
    await expect(transport?.handshakeProvider?.()).resolves.toEqual({
      v: 1,
      kind: 'provider_broker',
      authority: expect.objectContaining({ payload: expect.objectContaining({ grantId: 'grant-2' }) }),
    });
    expect(refreshBrokerOpen).toHaveBeenCalledOnce();
  });

  it('withdraws the Team bearer listener while exact signed retirement is pending', async () => {
    let finishRetirement!: () => void;
    const retirement = new Promise<void>(resolve => { finishRetirement = resolve; });
    let retirementStarted!: () => void;
    const started = new Promise<void>(resolve => { retirementStarted = resolve; });
    const listeners: Array<() => Promise<void>> = [];
    const openHttpTunnel: DaemonMachineIrohRuntime['openHttpTunnel'] = async () => {
      const localCapability = (listeners.length === 0 ? 'c' : 'd').repeat(64);
      const server = createServer(async (request, response) => {
        if (request.headers['x-happier-machine-local-capability'] !== localCapability) {
          response.writeHead(403).end();
          return;
        }
        if (request.method === 'DELETE') {
          retirementStarted();
          await retirement;
          response.writeHead(204).end();
        } else response.end('reachable');
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('listener unavailable');
      let closing: Promise<void> | null = null;
      const close = () => closing ??= new Promise<void>(resolve => { server.close(() => resolve()); });
      listeners.push(close);
      return { localPort: address.port, localCapability, remoteEndpointId: targetEndpoint, observedPath: 'relay', close };
    };
    const open = createProviderBrokerMachineCarrierTunnelOpen({ accountId: 'account-worker', localMachineId: 'machine-worker',
      // Native HTTP is the genuine OS boundary; route signing, peer checks and
      // retirement remain the canonical carrier implementation.
      runtime: { endpoint: { endpointId: initiatorEndpoint }, openHttpTunnel } as never,
      resolveTrustRoots: () => [root], nowMs: () => 200 });
    const tunnel = await open({ brokerOpen: brokerOpen() });
    const endpointUrl = `http://127.0.0.1:${tunnel.localPort}/v1`;
    const headers = { authorization: `Bearer ${tunnel.localCapability}`, 'x-happier-machine-local-capability': tunnel.localCapability };
    let retiring: Promise<void> | null = null;
    try {
      expect(await (await fetch(endpointUrl, { headers })).text()).toBe('reachable');
      retiring = tunnel.retire();
      await started;
      await expect(fetch(endpointUrl, { headers })).rejects.toBeDefined();
    } finally {
      finishRetirement();
      await retiring;
      await Promise.all(listeners.map(close => close()));
    }
  });

  it('retires the signed broker stream on an unpublished capability after withdrawing the consumer', async () => {
    const order: string[] = [];
    const close = vi.fn(async () => { order.push('transport-close'); });
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      order.push('retire-ack');
      expect(init).toMatchObject({
        method: 'DELETE',
        redirect: 'error',
        headers: expect.objectContaining({
          authorization: expect.stringMatching(/^Bearer /),
          'x-happier-machine-local-capability': 'd'.repeat(64),
        }),
      });
      return new Response(null, { status: 204 });
    });
    let opened = 0;
    const openHttpTunnel = vi.fn<DaemonMachineIrohRuntime['openHttpTunnel']>(async () => ({
      localPort: 41_001 + opened,
      localCapability: (opened++ === 0 ? 'c' : 'd').repeat(64),
      remoteEndpointId: targetEndpoint,
      observedPath: 'relay' as const,
      close,
    }));
    const open = createProviderBrokerMachineCarrierTunnelOpen({
      accountId: 'account-worker',
      localMachineId: 'machine-worker',
      runtime: { endpoint: { endpointId: initiatorEndpoint }, openHttpTunnel } as never,
      resolveTrustRoots: () => [root],
      nowMs: () => 200,
      fetchImpl,
    });

    const tunnel = await open({ brokerOpen: brokerOpen() });
    await tunnel.retire();
    await tunnel.retire();
    await tunnel.close();

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(`http://127.0.0.1:41002${PROVIDER_BROKER_PRIVATE_CLOSE_PATH}`);
    expect(order).toEqual(['transport-close', 'retire-ack', 'transport-close']);
  });

  it('releases its own claim on the retained authority, without a fresh Home admission and after cancellation', async () => {
    const binding = new AbortController();
    const close = vi.fn(async () => undefined);
    const openHttpTunnel = vi.fn<DaemonMachineIrohRuntime['openHttpTunnel']>(async () => ({
      localPort: 41_001,
      localCapability: 'c'.repeat(64),
      remoteEndpointId: targetEndpoint,
      observedPath: 'relay' as const,
      close,
    }));
    const signed = authority();
    let retireAttempt = 0;
    const fetchImpl = vi.fn(async () => {
      retireAttempt += 1;
      // The stream the DELETE travels over is dialled by the transport, which
      // runs the handshake provider for every accepted local connection.
      const transport = openHttpTunnel.mock.calls.at(-1)?.[0];
      await expect(transport?.handshakeProvider?.()).resolves.toEqual({
        v: 1,
        kind: 'provider_broker',
        authority: signed,
      });
      return new Response(null, { status: retireAttempt === 1 ? 502 : 204 });
    });
    // Home refuses a fresh inference admission precisely because the Session
    // that ended is the reason we are releasing.
    let ended = false;
    const refreshBrokerOpen = vi.fn(async () => ended
      ? { ok: false as const, reasonCode: 'session_not_active' as const } : brokerOpen(signed));
    const open = createProviderBrokerMachineCarrierTunnelOpen({
      accountId: 'account-worker',
      localMachineId: 'machine-worker',
      runtime: { endpoint: { endpointId: initiatorEndpoint }, openHttpTunnel } as never,
      resolveTrustRoots: () => [root],
      nowMs: () => 200,
      fetchImpl,
    });

    const tunnel = await open({ brokerOpen: brokerOpen(signed), refreshBrokerOpen, signal: binding.signal });
    ended = true;
    binding.abort();

    await expect(tunnel.retire()).resolves.toBeUndefined();
    // A remote refusal is terminal; retained cleanup cannot redial or resend.
    await expect(tunnel.retire()).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(refreshBrokerOpen).toHaveBeenCalledOnce();
    await expect(openHttpTunnel.mock.calls[0]?.[0].handshakeProvider?.()).rejects.toMatchObject({ code: 'broker_consumer_closed' });
  });

  it('fails a new stream closed when Home returns a changed sealed binding', async () => {
    const openHttpTunnel = vi.fn<DaemonMachineIrohRuntime['openHttpTunnel']>(async () => ({
      localPort: 41_001,
      localCapability: 'c'.repeat(64),
      remoteEndpointId: targetEndpoint,
      observedPath: 'direct' as const,
      close: vi.fn(async () => undefined),
    }));
    const open = createProviderBrokerMachineCarrierTunnelOpen({
      accountId: 'account-worker', localMachineId: 'machine-worker',
      runtime: { endpoint: { endpointId: initiatorEndpoint }, openHttpTunnel } as never,
      resolveTrustRoots: () => [root], nowMs: () => 200,
    });
    let refreshes = 0;
    await open({
      brokerOpen: brokerOpen(),
      refreshBrokerOpen: async () => ++refreshes === 1 ? brokerOpen() : brokerOpen(authority({ resourceId: 'other-resource' })),
    });
    const transport = openHttpTunnel.mock.calls[0]?.[0];
    await expect(transport?.handshakeProvider?.()).resolves.toMatchObject({ kind: 'provider_broker' });
    await expect(transport?.handshakeProvider?.()).rejects.toMatchObject({ code: 'broker_binding_changed' });
  });

  it('settles acknowledged retirement even if private control close fails', async () => {
    let opened = 0;
    let controlClosed = false;
    let closeFailed = false;
    let releases = 0;
    const openHttpTunnel: DaemonMachineIrohRuntime['openHttpTunnel'] = async () => {
      const control = opened++ !== 0;
      return { localPort: control ? 41002 : 41001, localCapability: (control ? 'd' : 'c').repeat(64),
        remoteEndpointId: targetEndpoint, observedPath: 'relay', close: async () => {
          if (!control) return;
          if (!closeFailed) { closeFailed = true; throw new Error('native release failed'); }
          controlClosed = true;
        } };
    };
    const open = createProviderBrokerMachineCarrierTunnelOpen({ accountId: 'account-worker', localMachineId: 'machine-worker',
      runtime: { endpoint: { endpointId: initiatorEndpoint }, openHttpTunnel } as never,
      resolveTrustRoots: () => [root], nowMs: () => 200,
      fetchImpl: async () => { releases++; return new Response(null, { status: 204 }); } });
    const tunnel = await open({ brokerOpen: brokerOpen() });
    const diagnostics = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    await expect(tunnel.retire()).resolves.toBeUndefined();
    expect(diagnostics.mock.calls).toContainEqual(['[provider-broker-release] Boundary failure', expect.objectContaining({ cause: {
      phase: 'private_control_close', error: expect.objectContaining({ message: 'native release failed' }),
      targetMachineId: 'machine-broker', requestId: expect.any(String),
    } })]);
    diagnostics.mockRestore();
    await expect(tunnel.retire()).resolves.toBeUndefined();
    expect(controlClosed).toBe(false);
    expect(releases).toBe(1);
    expect(opened).toBe(2);
  });

  it.each(['first', 'later'] as const)('rejects an expired witness before the %s stream opens', async stream => {
    const openHttpTunnel = vi.fn<DaemonMachineIrohRuntime['openHttpTunnel']>(async () => ({
      localPort: 41_004, localCapability: 'f'.repeat(64), remoteEndpointId: targetEndpoint,
      observedPath: 'direct' as const, close: vi.fn(async () => undefined),
    }));
    const times = stream === 'first' ? [200, 200, 200, 20_000] : [200, 200, 200, 200, 20_000];
    const refreshBrokerOpen = vi.fn(async () => brokerOpen(authority({ grantId: `fresh-${refreshBrokerOpen.mock.calls.length}` })));
    const open = createProviderBrokerMachineCarrierTunnelOpen({
      accountId: 'account-worker', localMachineId: 'machine-worker',
      runtime: { endpoint: { endpointId: initiatorEndpoint }, openHttpTunnel } as never,
      resolveTrustRoots: () => [root], nowMs: () => times.shift() ?? 20_000,
    });
    await open({ brokerOpen: brokerOpen(), refreshBrokerOpen });
    const provider = openHttpTunnel.mock.calls[0]?.[0].handshakeProvider;
    if (stream === 'later') await expect(provider?.()).resolves.toMatchObject({ kind: 'provider_broker' });
    await expect(provider?.()).rejects.toMatchObject({ code: 'grant_expired' });
    expect(refreshBrokerOpen).toHaveBeenCalledTimes(stream === 'first' ? 1 : 2);
  });

  it('rejects either a substituted open witness or a tampered signed endpoint before dialing', async () => {
    const openHttpTunnel = vi.fn();
    const open = createProviderBrokerMachineCarrierTunnelOpen({
      accountId: 'account-worker', localMachineId: 'machine-worker',
      runtime: { endpoint: { endpointId: initiatorEndpoint }, openHttpTunnel } as never,
      resolveTrustRoots: () => [root], nowMs: () => 200,
    });
    const signed = authority();
    const substituted = {
      ...signed,
      payload: {
        ...signed.payload,
        target: { ...signed.payload.target, endpointId: 'c'.repeat(64) },
      },
    };
    await expect(open({ brokerOpen: brokerOpen(authority(), { endpointId: 'c'.repeat(64) }) }))
      .rejects.toMatchObject({ code: 'broker_target_endpoint_changed' });
    await expect(open({ brokerOpen: brokerOpen(substituted) }))
      .rejects.toMatchObject({ code: 'grant_bad_signature' });
    await expect(open({ brokerOpen: brokerOpen(authority({
      initiator: {
        accountId: 'account-worker',
        machineId: 'machine-worker',
        endpointId: 'd'.repeat(64),
      },
    })) }))
      .rejects.toMatchObject({ code: 'broker_initiator_mismatch' });
    expect(openHttpTunnel).not.toHaveBeenCalled();
  });

  it.each(['consumer', 'control'] as const)('closes a %s tunnel whose authenticated remote identity does not match the signed target', async (phase) => {
    const close = vi.fn(async () => undefined);
    let opened = 0;
    const openHttpTunnel = vi.fn(async () => ({
      localPort: 41_002,
      localCapability: 'd'.repeat(64),
      remoteEndpointId: phase === 'control' && opened++ === 0 ? targetEndpoint : 'c'.repeat(64),
      observedPath: 'direct' as const,
      close,
    }));
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const open = createProviderBrokerMachineCarrierTunnelOpen({
      accountId: 'account-worker', localMachineId: 'machine-worker',
      runtime: { endpoint: { endpointId: initiatorEndpoint }, openHttpTunnel } as never,
      resolveTrustRoots: () => [root], nowMs: () => 200,
      fetchImpl,
    });
    if (phase === 'control') {
      const tunnel = await open({ brokerOpen: brokerOpen() });
      await expect(tunnel.retire()).resolves.toBeUndefined();
    } else await expect(open({ brokerOpen: brokerOpen() })).rejects.toMatchObject({ code: 'transport_identity_mismatch' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(phase === 'control' ? 2 : 1);
  });

  it('rechecks signed authority currentness immediately before dialing', async () => {
    const openHttpTunnel = vi.fn();
    const times = [200, 20_000];
    const open = createProviderBrokerMachineCarrierTunnelOpen({
      accountId: 'account-worker', localMachineId: 'machine-worker',
      runtime: { endpoint: { endpointId: initiatorEndpoint }, openHttpTunnel } as never,
      resolveTrustRoots: () => [root],
      nowMs: () => times.shift() ?? 20_000,
    });
    await expect(open({ brokerOpen: brokerOpen() })).rejects.toMatchObject({ code: 'grant_expired' });
    expect(openHttpTunnel).not.toHaveBeenCalled();
  });

  it('settles promptly on cancellation while native open is pending and closes its late tunnel', async () => {
    const close = vi.fn(async () => undefined);
    let resolveTunnel!: (value: {
      localPort: number;
      localCapability: string;
      remoteEndpointId: string;
      observedPath: 'relay';
      close(): Promise<void>;
    }) => void;
    const pendingTunnel = new Promise<Parameters<typeof resolveTunnel>[0]>((resolve) => { resolveTunnel = resolve; });
    const openHttpTunnel = vi.fn(async () => await pendingTunnel);
    const open = createProviderBrokerMachineCarrierTunnelOpen({
      accountId: 'account-worker', localMachineId: 'machine-worker',
      runtime: { endpoint: { endpointId: initiatorEndpoint }, openHttpTunnel } as never,
      resolveTrustRoots: () => [root], nowMs: () => 200,
    });
    const controller = new AbortController();
    const reason = new Error('cancelled native dial');
    const result = open({ brokerOpen: brokerOpen(), signal: controller.signal });
    await vi.waitFor(() => expect(openHttpTunnel).toHaveBeenCalledOnce());
    controller.abort(reason);

    await expect(Promise.race([
      result,
      new Promise((_, reject) => setTimeout(() => reject(new Error('cancellation did not settle')), 100)),
    ])).rejects.toBe(reason);
    resolveTunnel({
      localPort: 41_003,
      localCapability: 'e'.repeat(64),
      remoteEndpointId: targetEndpoint,
      observedPath: 'relay',
      close,
    });
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
  });
});
