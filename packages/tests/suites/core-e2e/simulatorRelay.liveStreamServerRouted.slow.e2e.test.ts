import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

import { io as socketIo, type Socket as SocketIoClient } from 'socket.io-client';
import tweetnacl from 'tweetnacl';

import {
  MACHINE_LIVE_STREAM_SOCKET_EVENT,
  MachineLiveStreamRelayAuthorizationV1Schema,
  type MachineLiveStreamRelayAuthorizationV1,
} from '@happier-dev/protocol';

import { createTestAuth } from '../../src/testkit/auth';
import { fetchJson } from '../../src/testkit/http';
import {
  createMachineInstallationIdentityFixture,
  registerMachineIdentity,
} from '../../src/testkit/machineIdentity';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createRunDirs } from '../../src/testkit/runDir';
import { sleep, waitFor } from '../../src/testkit/timing';

/**
 * Layer coverage for the server-routed simulator live-stream relay. This intentionally drives
 * the server socket relay layer with a synthetic machine-scoped socket:
 *
 *   mint (HTTP route, Ed25519-signed) → source machine-scoped socket emits start+frame →
 *   server `machineLiveStreamRelayHandler` verifies the grant + caps → routes the frame to the
 *   exact viewer tab via `io.to(viewerSocketId)` → viewer user-scoped socket receives it.
 *
 * It proves the per-tab relay isolation the relay-identity fix requires, but it is not a live
 * producer-backed end-to-end pass. Product-path E2E coverage belongs in the L6 live QA suites.
 */

const run = createRunDirs({ runLabel: 'core' });

function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

type RelayEnvelope = {
  v: 1;
  sourceMachineId: string;
  targetMachineId: string;
  viewerSocketId?: string;
  message: unknown;
};

async function connectRawSocket(params: Readonly<{
  baseUrl: string;
  token: string;
  clientType: 'user-scoped' | 'machine-scoped';
  machineId?: string;
}>): Promise<SocketIoClient> {
  const socket = socketIo(params.baseUrl, {
    path: '/v1/updates/',
    auth: {
      token: params.token,
      clientType: params.clientType,
      ...(params.machineId ? { machineId: params.machineId } : {}),
    },
    transports: ['websocket'],
    reconnection: false,
    autoConnect: false,
  });
  socket.connect();
  await waitFor(() => socket.connected === true, {
    timeoutMs: 20_000,
    context: `${params.clientType} socket connected`,
  });
  return socket;
}

function liveStreamFrameEnvelope(params: Readonly<{
  sourceMachineId: string;
  targetMachineId: string;
  viewerSocketId: string;
  streamId: string;
  sequence: number;
}>): RelayEnvelope {
  const payloadBase64 = Buffer.from(new Uint8Array([1, 2, 3])).toString('base64');
  return {
    v: 1,
    sourceMachineId: params.sourceMachineId,
    targetMachineId: params.targetMachineId,
    viewerSocketId: params.viewerSocketId,
    message: {
      kind: 'frame',
      frame: {
        v: 1,
        streamId: params.streamId,
        sequence: params.sequence,
        timestampMs: 2_000 + params.sequence,
        payloadKind: params.sequence === 1 ? 'image_keyframe' : 'image_delta',
        payloadEncoding: 'binary_base64',
        payloadBase64,
        payloadSizeBytes: 3,
      },
    },
  };
}

describe('core layer: simulator live-stream relay server routing', () => {
  let server: StartedServer | null = null;
  const sockets: SocketIoClient[] = [];

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.close();
    await server?.stop().catch(() => {});
    server = null;
  });

  it('routes a server-relayed frame to the bound viewer tab only (two-tab isolation)', async () => {
    const testDir = run.testDir(`relay-live-stream-${randomUUID()}`);
    const keyPair = tweetnacl.sign.keyPair();

    server = await startServerLight({
      testDir,
      dbProvider: 'sqlite',
      extraEnv: {
        HANDY_MASTER_SECRET: `relay-e2e-${randomUUID()}`,
        HAPPIER_FEATURE_MACHINES_LIVE_STREAM_DIRECT_PEER__ENABLED: 'true',
        HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__ENABLED: 'true',
        HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_BITRATE_BPS: '64000',
        HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_FRAMES_PER_SECOND: '12',
        HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_FRAME_BYTES: '32000',
        HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_DURATION_MS: '60000',
        HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_TOTAL_BYTES: '128000',
        HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_CONCURRENT_STREAMS_PER_ACCOUNT: '4',
        HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_CONCURRENT_STREAMS_PER_SOCKET: '2',
        HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_CONCURRENT_STREAMS_PER_MACHINE: '2',
        HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_KEY_ID: 'relay-e2e-grant-key',
        HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PRIVATE_KEY: toBase64Url(keyPair.secretKey),
        HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PUBLIC_KEY: toBase64Url(keyPair.publicKey),
        HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_EXPIRES_AT: String(Date.now() + 60 * 60 * 1000),
      },
    });

    const auth = await createTestAuth(server.baseUrl);
    const attacker = await createTestAuth(server.baseUrl);

    // Two real owned machines: the source (running the simulator) and the relay target.
    const installation = createMachineInstallationIdentityFixture();
    const sourceMachineId = `machine_${randomUUID()}`;
    const targetMachineId = `machine_${randomUUID()}`;
    expect((await registerMachineIdentity({ baseUrl: server.baseUrl, token: auth.token, machineId: sourceMachineId, installation })).status).toBe(200);
    expect((await registerMachineIdentity({ baseUrl: server.baseUrl, token: auth.token, machineId: targetMachineId })).status).toBe(200);
    const attackerSourceMachineId = `machine_${randomUUID()}`;
    const attackerTargetMachineId = `machine_${randomUUID()}`;
    expect((await registerMachineIdentity({ baseUrl: server.baseUrl, token: attacker.token, machineId: attackerSourceMachineId })).status).toBe(200);
    expect((await registerMachineIdentity({ baseUrl: server.baseUrl, token: attacker.token, machineId: attackerTargetMachineId })).status).toBe(200);

    // Two browser tabs (user-scoped sockets) of the same account.
    const viewerTab1 = await connectRawSocket({ baseUrl: server.baseUrl, token: auth.token, clientType: 'user-scoped' });
    const viewerTab2 = await connectRawSocket({ baseUrl: server.baseUrl, token: auth.token, clientType: 'user-scoped' });
    sockets.push(viewerTab1, viewerTab2);
    expect(typeof viewerTab1.id).toBe('string');

    const tab1Frames: RelayEnvelope[] = [];
    const tab2Frames: RelayEnvelope[] = [];
    const isFrame = (payload: RelayEnvelope): boolean =>
      typeof payload?.message === 'object'
      && payload.message !== null
      && (payload.message as { kind?: unknown }).kind === 'frame';
    viewerTab1.on(MACHINE_LIVE_STREAM_SOCKET_EVENT, (payload: RelayEnvelope) => {
      if (isFrame(payload)) tab1Frames.push(payload);
    });
    viewerTab2.on(MACHINE_LIVE_STREAM_SOCKET_EVENT, (payload: RelayEnvelope) => {
      if (isFrame(payload)) tab2Frames.push(payload);
    });

    const streamId = `stream_${randomUUID()}`;
    const viewerSocketId = viewerTab1.id!;

    // A different authenticated account can own valid machines but must not mint a grant to a
    // stolen viewer socket id from this account/tab.
    const stolenViewerMintResponse = await fetchJson<{ ok?: boolean; reasonCode?: string; relayAuthorization?: unknown }>(
      `${server.baseUrl}/v1/machines/peer/mediation/route-grants`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${attacker.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          machineId: attackerSourceMachineId,
          targetMachineId: attackerTargetMachineId,
          flowKind: 'live_stream',
          routeKind: 'server_relay',
          ttlMs: 900_000,
          maxFramesPerSecond: 12,
          maxFrameBytes: 32_000,
          viewerSocketId,
          scope: {
            kind: 'live_stream',
            streamId: `stream_${randomUUID()}`,
            streamFamily: 'screen',
            maxBitrateBps: 64_000,
            maxDurationMs: 60_000,
            maxTotalBytes: 128_000,
          },
        }),
        timeoutMs: 20_000,
      },
    );
    expect(stolenViewerMintResponse.data.ok).toBe(false);
    expect(stolenViewerMintResponse.data.reasonCode).toBe('viewer_socket_not_owned');
    expect(stolenViewerMintResponse.data.relayAuthorization).toBeUndefined();

    // Mint a viewer-bound grant through the REAL signing route.
    const mintResponse = await fetchJson<{ ok?: boolean; relayAuthorization?: unknown; reasonCode?: string }>(
      `${server.baseUrl}/v1/machines/peer/mediation/route-grants`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${auth.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          machineId: sourceMachineId,
          targetMachineId,
          flowKind: 'live_stream',
          routeKind: 'server_relay',
          ttlMs: 900_000,
          maxFramesPerSecond: 12,
          maxFrameBytes: 32_000,
          viewerSocketId,
          scope: {
            kind: 'live_stream',
            streamId,
            streamFamily: 'screen',
            maxBitrateBps: 64_000,
            maxDurationMs: 60_000,
            maxTotalBytes: 128_000,
          },
        }),
        timeoutMs: 20_000,
      },
    );
    expect(mintResponse.data.ok).toBe(true);
    const parsed = MachineLiveStreamRelayAuthorizationV1Schema.safeParse(mintResponse.data.relayAuthorization);
    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      throw new Error(`mint failed: ${JSON.stringify(mintResponse.data)}`);
    }
    const authorization: MachineLiveStreamRelayAuthorizationV1 = parsed.data;
    expect(authorization.payload.viewerSocketId).toBe(viewerSocketId);

    // The source daemon connects as a machine-scoped socket and starts the stream.
    const source = await connectRawSocket({
      baseUrl: server.baseUrl,
      token: auth.token,
      clientType: 'machine-scoped',
      machineId: sourceMachineId,
    });
    sockets.push(source);

    source.emit(MACHINE_LIVE_STREAM_SOCKET_EVENT, {
      v: 1,
      sourceMachineId,
      targetMachineId,
      viewerSocketId,
      message: {
        kind: 'start',
        startRequest: {
          v: 1,
          streamId,
          streamFamily: 'screen',
          routeKind: 'server_relay',
          sourceMachineId,
          targetMachineId,
          viewerSocketId,
          maxBitrateBps: 64_000,
          maxFramesPerSecond: 12,
          maxFrameBytes: 32_000,
          maxDurationMs: 60_000,
          maxTotalBytes: 128_000,
          authorization,
        },
      },
    });

    // Push frames until the bound tab observes one (start processing is async on the server).
    let sequence = 0;
    await waitFor(() => {
      sequence += 1;
      source.emit(
        MACHINE_LIVE_STREAM_SOCKET_EVENT,
        liveStreamFrameEnvelope({ sourceMachineId, targetMachineId, viewerSocketId, streamId, sequence: Math.max(1, sequence) }),
      );
      return tab1Frames.length > 0;
    }, {
      timeoutMs: 30_000,
      intervalMs: 250,
      context: 'viewer tab 1 receives a server-relayed live-stream frame',
    });

    expect(tab1Frames.length).toBeGreaterThan(0);
    expect((tab1Frames[0].message as { frame?: { streamId?: string } }).frame?.streamId).toBe(streamId);

    // Give the server a beat to (incorrectly) fan out before asserting tab 2 isolation.
    await sleep(750);
    expect(tab2Frames.length).toBe(0);
  });
});
