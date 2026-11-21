import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Socket } from 'node:net';
import { once } from 'node:events';
import WebSocket from 'ws';
import { MACHINE_ALPN, MACHINE_HTTP_LOCAL_CAPABILITY_HEADER } from '@happier-dev/iroh-native/node';
import { DIRECT_ROUTE_GRANT_TTL_MS } from '@happier-dev/protocol/machines/peer/mediation/directRouteGrantCachePolicyV1';
import { DirectRouteGrantRequestV2Schema, SignedDirectRouteGrantV2Schema, type DirectRouteGrantRequestV2 } from '@happier-dev/protocol/machines/peer/mediation/directRouteGrantV2';
import { createTcpTunnelServiceExportCommitmentV1, TcpTunnelServiceExportBindingV1Schema, type TcpTunnelServiceExportBindingV1 } from '@happier-dev/protocol/machines/peer/mediation/directRouteGrantScopesV1';
import { createEphemeralPeerRouteProofHandleV2 } from '@happier-dev/protocol/machines/peer/mediation/ephemeralPeerRouteProofV2';
import { IrohMachineHandshakeV1Schema } from '@happier-dev/protocol/connectivity/iroh/machineHandshakeV1';
import { readMachineIrohEndpointAuthorityV1 } from '@happier-dev/protocol/machines/operationProtocolCapabilitiesV1';
import type { IrohEndpointDescriptorV1 } from '@happier-dev/protocol/connectivity/iroh/endpointDescriptorV1';
import { PEER_TCP_TUNNEL_OPEN_PATH_V2 } from '@happier-dev/protocol/machines/peer/mediation/tunnel/openAuthorizationV2';
import { PeerTcpTunnelOpenResponseV1Schema } from '@happier-dev/protocol/machines/peer/mediation/tunnel/v1';
import { createPeerTcpTunnelStreamSession, decodePeerTcpTunnelBinarySubstreamFrame, encodePeerTcpTunnelBinaryFrameForSubstream,
  encodePeerTcpTunnelBinarySubstreamOpen } from '@happier-dev/peer-transport/duplexFrames';
import type { DaemonMachineIrohRuntime } from './daemonMachineIrohRuntime';
import type { DirectRouteGrantTrustRoot } from '../mediation/verifyDirectRouteGrant';
import { peerTcpTunnelSocketConnection, SERVICE_EXPORT_POLICY_CLOSE_CODE } from '../mediation/tunnel/open';
import { awaitMachineCarrierControlPlane, awaitMachineCarrierTunnelOpen, machineCarrierUnavailableError,
  MachineCarrierError, verifyMachineCarrierHandshakeV1 } from './machineCarrier';

export type ServiceExportMachineForward = Readonly<{
  host: string; port: number; observedPath: 'direct' | 'relay' | 'unknown'; close(): Promise<void>;
}>;

/** One consumer-owned loopback publication; authorization belongs to grant issuance and B's inner open. */
export function createServiceExportMachineForward(input: Readonly<{
  accountId: string; localMachineId: string;
  runtime: Pick<DaemonMachineIrohRuntime, 'endpoint' | 'openHttpTunnel'>;
  resolveTrustRoots(): readonly DirectRouteGrantTrustRoot[];
  readTargetMachine(machineId: string, signal?: AbortSignal): Promise<Readonly<{
    id: string; operationProtocolCapabilities?: unknown; operationProtocolCapabilitiesRevision?: unknown;
  }> | null>;
  mintGrant(request: DirectRouteGrantRequestV2, signal?: AbortSignal): Promise<unknown>;
  nowMs?: () => number;
}>): (request: Readonly<{ targetMachineId: string; serviceExport: TcpTunnelServiceExportBindingV1; preferredListenPort?: number;
  signal?: AbortSignal; onFailure?: (error: MachineCarrierError) => void; onRecovered?: () => void }>) => Promise<ServiceExportMachineForward> {
  return async request => {
    request.signal?.throwIfAborted();
    const binding = TcpTunnelServiceExportBindingV1Schema.parse(request.serviceExport);
    const server = createServer({ allowHalfOpen: true, pauseOnConnect: true });
    const lifetime = new AbortController();
    const signal = lifetime.signal;
    let current: Promise<Readonly<{ observedPath: ServiceExportMachineForward['observedPath']; accept(client: Socket): void; close(): Promise<void> }>> | undefined;
    let destinationFailed = false;
    let closing: Promise<void> | undefined;
    const close = (): Promise<void> => {
      closing ??= (async () => {
        request.signal?.removeEventListener('abort', onAbort);
        const stopped = server.listening ? new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) : Promise.resolve();
        lifetime.abort();
        const connected = await current?.catch(() => undefined);
        await Promise.all([stopped, connected?.close()]);
      })();
      return closing;
    };
    const onAbort = () => { void close().catch(() => undefined); };
    const notifyObserver = (notify: () => void): void => {
      // The consumer owns diagnostics. Observer failure cannot interrupt transport disposal.
      void Promise.resolve().then(notify).catch(() => undefined);
    };
    const connectCarrier = async () => {
      signal.throwIfAborted();
      const nonce = randomBytes(32).toString('hex');
      const target = await awaitMachineCarrierControlPlane(input.readTargetMachine(request.targetMachineId, signal), signal);
      const endpoint = readMachineIrohEndpointAuthorityV1({ capabilities: target?.operationProtocolCapabilities,
        revision: target?.operationProtocolCapabilitiesRevision });
      if (!target || target.id !== request.targetMachineId || !endpoint) throw machineCarrierUnavailableError();
      const proofHandle = createEphemeralPeerRouteProofHandleV2({ randomBytes: length => new Uint8Array(randomBytes(length)) });
      let carrier: Awaited<ReturnType<DaemonMachineIrohRuntime['openHttpTunnel']>> | undefined;
      let socket: WebSocket | undefined;
      const sessions = new Map<string, { session: ReturnType<typeof createPeerTcpTunnelStreamSession>; recoveryEligible: boolean }>();
      let disposing: Promise<void> | undefined;
      const dispose = (): Promise<void> => {
        disposing ??= (async () => {
          socket?.terminate();
          await Promise.all([...sessions.values()].map(({ session }) => session.close()));
          await carrier?.close();
        })();
        return disposing;
      };
      try {
        const tunnelId = randomUUID();
        const grantRequest = DirectRouteGrantRequestV2Schema.parse({
          v: 2, kind: 'ephemeral_ed25519', ephemeralPublicKeyBase64Url: proofHandle.publicKeyBase64Url,
          machineId: request.targetMachineId, flowKind: 'tcp_tunnel', routeKind: 'iroh_peer', endpointFingerprint: endpoint.endpointId,
          ttlMs: DIRECT_ROUTE_GRANT_TTL_MS.directTcpTunnel,
          scope: { kind: 'tcp_tunnel', tunnelId, allowedPorts: [binding.destination.port],
            serviceExport: { commitment: createTcpTunnelServiceExportCommitmentV1(binding, nonce) } },
          iroh: { initiator: { kind: 'machine', machineId: input.localMachineId, endpointId: input.runtime.endpoint.endpointId },
            target: { machineId: request.targetMachineId, endpointId: endpoint.endpointId }, operationKind: 'tcp_tunnel' },
        });
        const grant = SignedDirectRouteGrantV2Schema.parse(await awaitMachineCarrierControlPlane(input.mintGrant(grantRequest, signal), signal));
        const proof = proofHandle.sign(grant);
        const handshake = IrohMachineHandshakeV1Schema.parse({ v: 1, accountId: grant.payload.accountId, flow: 'tcp_tunnel',
          initiator: grant.payload.iroh?.initiator, target: grant.payload.iroh?.target, grant, proof });
        const verified = verifyMachineCarrierHandshakeV1({ handshake, accountId: input.accountId, machineId: input.localMachineId,
          localEndpointId: input.runtime.endpoint.endpointId, role: 'initiator', trustRoots: input.resolveTrustRoots(), nowMs: (input.nowMs ?? Date.now)() });
        const descriptor: IrohEndpointDescriptorV1 = { endpointId: endpoint.endpointId,
          ...(endpoint.relayUrls ? { relayUrls: [...endpoint.relayUrls] } : {}),
          ...(endpoint.directAddresses ? { directAddresses: [...endpoint.directAddresses] } : {}) };
        carrier = await awaitMachineCarrierTunnelOpen(input.runtime.openHttpTunnel({ alpn: MACHINE_ALPN,
          remoteEndpointId: verified.remoteEndpointId, flow: 'tcp_tunnel', handshake }, descriptor), signal);
        if (carrier.remoteEndpointId !== verified.remoteEndpointId) throw new MachineCarrierError('transport_identity_mismatch', 'The authenticated Machine endpoint changed.');
        const origin = `http://127.0.0.1:${carrier.localPort}`;
        const response = await fetch(new URL(PEER_TCP_TUNNEL_OPEN_PATH_V2, origin), { method: 'POST', redirect: 'error', signal,
          headers: { 'content-type': 'application/json', [MACHINE_HTTP_LOCAL_CAPABILITY_HEADER]: carrier.localCapability },
          body: JSON.stringify({ v: 2, kind: 'open', tunnelId, targetMachineId: request.targetMachineId, routeKind: 'iroh_peer', destination: binding.destination,
            serviceExport: { binding, nonce }, grant, proof }) });
        const body: unknown = await response.json();
        if (!response.ok) {
          if (body && typeof body === 'object' && 'reasonCode' in body && typeof body.reasonCode === 'string') {
            throw new MachineCarrierError(body.reasonCode, 'The destination rejected the service tunnel.');
          }
          throw new Error('Service tunnel admission failed', { cause: body });
        }
        const admitted = PeerTcpTunnelOpenResponseV1Schema.parse(body);
        const streamUrl = new URL(admitted.streamPath, origin);
        streamUrl.protocol = 'ws:';
        streamUrl.searchParams.set('tunnelId', tunnelId);
        socket = new WebSocket(streamUrl, { headers: { [MACHINE_HTTP_LOCAL_CAPABILITY_HEADER]: carrier.localCapability } });
        // ws emits close after error. The close code distinguishes withdrawal from transport loss.
        socket.on('error', () => {});
        await once(socket, 'open', { signal });
        signal.throwIfAborted();
        const transport = socket;
        transport.once('close', code => {
          if (disposing || signal.aborted) return;
          if (code === SERVICE_EXPORT_POLICY_CLOSE_CODE) {
            notifyObserver(() => request.onFailure?.(new MachineCarrierError('service_export_unavailable', 'The service export was withdrawn.')));
            onAbort();
            return;
          }
          current = undefined;
          destinationFailed = true;
          void dispose().catch(() => undefined);
          if (server.listening) notifyObserver(() => request.onFailure?.(machineCarrierUnavailableError()));
        });
        const send = (bytes: Uint8Array): Promise<void> => new Promise((resolve, reject) => transport.send(bytes, error => error ? reject(error) : resolve()));
        let inbound = Promise.resolve();
        socket.on('message', raw => {
          const bytes = Array.isArray(raw) ? Buffer.concat(raw) : raw instanceof ArrayBuffer ? new Uint8Array(raw) : raw;
          inbound = inbound.then(async () => {
            const decoded = decodePeerTcpTunnelBinarySubstreamFrame({ frame: bytes, maxBinaryHeaderBytes: admitted.maxFrameBytes, maxRawPayloadBytes: admitted.maxFrameBytes });
            if (disposing || signal.aborted) return;
            if (!decoded.ok || decoded.frame.tunnelId !== tunnelId) { onAbort(); return; }
            const active = sessions.get(decoded.substreamId);
            if (active) {
              if (decoded.frame.kind === 'abort') {
                destinationFailed = decoded.frame.reasonCode === 'tcp_connect_failed';
                // Existing sibling traffic cannot prove a subsequent destination dial recovered.
                for (const entry of sessions.values()) entry.recoveryEligible = false;
                const failure = new MachineCarrierError(decoded.frame.reasonCode, 'The service connection failed.');
                notifyObserver(() => request.onFailure?.(failure));
              }
              const accepted = await active.session.acceptFrame(decoded.frame);
              if (accepted.ok && destinationFailed && active.recoveryEligible && !disposing && !signal.aborted
                && (decoded.frame.kind === 'data' || decoded.frame.kind === 'ack' && decoded.frame.nextSequence > 0)) {
                destinationFailed = false;
                notifyObserver(() => request.onRecovered?.());
              }
            }
          }).catch(onAbort);
        });
        const accept = (client: Socket): void => {
          if (disposing || signal.aborted || transport.readyState !== WebSocket.OPEN) { client.destroy(); return; }
          const substreamId = randomUUID();
          const session = createPeerTcpTunnelStreamSession({ tunnelId, outboundDirection: 'client_to_daemon',
            initialWindowBytes: admitted.initialWindowBytes, maxFrameBytes: admitted.maxFrameBytes,
            connection: peerTcpTunnelSocketConnection(client),
            sendFrame: frame => send(encodePeerTcpTunnelBinaryFrameForSubstream({ frame, substreamId })),
            onClosed: () => { sessions.delete(substreamId); } });
          sessions.set(substreamId, { session, recoveryEligible: destinationFailed });
          void send(encodePeerTcpTunnelBinarySubstreamOpen({ tunnelId, substreamId })).then(() => client.resume(), () => session.close());
        };
        return { observedPath: carrier.observedPath, accept, close: dispose };
      } catch (error) {
        await dispose().catch(() => undefined);
        throw error;
      } finally { proofHandle.dispose(); }
    };
    const getCarrier = () => current ??= connectCarrier().catch(error => {
      current = undefined;
      if (server.listening && !signal.aborted) {
        const failure = error instanceof MachineCarrierError ? error : machineCarrierUnavailableError();
        notifyObserver(() => request.onFailure?.(failure));
        if (failure.code === 'service_export_unavailable') onAbort();
      }
      throw error;
    });
    request.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const initial = await getCarrier();
      if (!current) throw machineCarrierUnavailableError();
      server.on('connection', client => {
        const onClientError = () => client.destroy();
        client.once('error', onClientError);
        // A new app connection can re-admit the same export after losing its carrier.
        // Concurrent clients share this admission, and an idle listener performs no work.
        void getCarrier().then(active => {
          if (client.destroyed) return;
          client.removeListener('error', onClientError);
          active.accept(client);
        }, () => client.destroy());
      });
      server.listen(request.preferredListenPort ?? 0, '127.0.0.1');
      await once(server, 'listening', { signal });
      server.on('error', onAbort);
      if (!current) throw machineCarrierUnavailableError();
      const address = server.address();
      if (!address || typeof address === 'string') throw machineCarrierUnavailableError();
      return { host: '127.0.0.1', port: address.port, observedPath: initial.observedPath, close };
    } catch (error) {
      await close().catch(() => undefined);
      throw error;
    }
  };
}
