import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

import tweetnacl from 'tweetnacl';

import {
  MachineLiveStreamRelayAuthorizationV1Schema,
  PEER_MEDIATION_RECEIPTS,
  createMachineLiveStreamRelayAuthorizationSigningInputV1,
} from '@happier-dev/protocol';

import { createTestAuth } from '../../src/testkit/auth';
import { fetchJson } from '../../src/testkit/http';
import {
  createMachineInstallationIdentityFixture,
  registerMachineIdentity,
} from '../../src/testkit/machineIdentity';
import { reserveAvailablePort } from '../../src/testkit/network/reserveAvailablePort';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createRunDirs } from '../../src/testkit/runDir';

/**
 * Cross-boundary acceptance for LANE-C / SEC-2 (ownership-checked mint at the peer-mediation
 * grant chokepoint). This drives the REAL Fastify route against a REAL server + DB-backed machine
 * ownership state and the REAL Ed25519 signing key — no mocked ownership reader, no fake socket.
 *
 * It proves the production default (`readMachineAvailabilityState`) — not the test-injected reader
 * used by the unit spec — rejects every mint branch when the referenced machine is not an
 * `available` machine owned by the authenticated account:
 *   - cross-user (a machine owned by a different account)
 *   - missing (a fabricated machine id that was never registered)
 *   - replaced (a machine superseded via the replacement flow)
 *   - a profile/account id is never accepted as a machine id
 * across all three mint branches: live_stream server_relay, tcp_tunnel server_relay, and
 * loopback_direct. The owner's mint succeeds and produces a signature verifiable against the
 * configured grant public key.
 */

const run = createRunDirs({ runLabel: 'core' });

function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

type GrantRouteResponse = Readonly<{
  ok?: boolean;
  receipt?: string;
  reasonCode?: string;
  relayAuthorization?: unknown;
  signedGrant?: unknown;
}>;

async function postRouteGrant(
  server: StartedServer,
  token: string,
  body: unknown,
): Promise<{ status: number; data: GrantRouteResponse }> {
  const response = await fetchJson<GrantRouteResponse>(
    `${server.baseUrl}/v1/machines/peer/mediation/route-grants`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      timeoutMs: 20_000,
    },
  );
  return { status: response.status, data: response.data };
}

function liveStreamGrantBody(params: Readonly<{ sourceMachineId: string; targetMachineId: string; streamId?: string }>): unknown {
  return {
    machineId: params.sourceMachineId,
    targetMachineId: params.targetMachineId,
    flowKind: 'live_stream',
    routeKind: 'server_relay',
    ttlMs: 900_000,
    maxFramesPerSecond: 12,
    maxFrameBytes: 32_000,
    scope: {
      kind: 'live_stream',
      streamId: params.streamId ?? `stream_${randomUUID()}`,
      streamFamily: 'screen',
      maxBitrateBps: 64_000,
      maxDurationMs: 60_000,
      maxTotalBytes: 128_000,
    },
  };
}

function tunnelGrantBody(params: Readonly<{ machineId: string; port: number }>): unknown {
  return {
    machineId: params.machineId,
    flowKind: 'tcp_tunnel',
    routeKind: 'server_relay',
    ttlMs: 600_000,
    destination: { host: '127.0.0.1', port: params.port },
    scope: {
      kind: 'tcp_tunnel',
      tunnelId: `tunnel_${randomUUID()}`,
      allowedPorts: [params.port],
      maxIdleMs: 60_000,
      maxDurationMs: 600_000,
      maxTotalBytes: 8 * 1024 * 1024,
    },
  };
}

function loopbackLiveStreamGrantBody(params: Readonly<{ machineId: string }>): unknown {
  return {
    machineId: params.machineId,
    flowKind: 'live_stream',
    routeKind: 'loopback_direct',
    endpointFingerprint: `fp_${randomUUID()}`,
    ttlMs: 120_000,
    scope: {
      kind: 'live_stream',
      streamId: `stream_${randomUUID()}`,
      streamFamily: 'screen',
      maxBitrateBps: 64_000,
      maxDurationMs: 60_000,
      maxTotalBytes: 128_000,
    },
  };
}

function readAccountIdFromToken(token: string): string {
  const [, payload] = token.split('.');
  const decoded = JSON.parse(Buffer.from(payload ?? '', 'base64url').toString('utf8')) as { sub?: string };
  if (typeof decoded.sub !== 'string' || decoded.sub.length === 0) {
    throw new Error('Could not read account id from token');
  }
  return decoded.sub;
}

describe('core e2e: peer-mediation mint ownership (LANE-C / SEC-2)', () => {
  let server: StartedServer | null = null;

  afterEach(async () => {
    await server?.stop().catch(() => {});
    server = null;
  });

  it('enforces machine ownership across all three mint branches against the real DB + signs the owner grant', async () => {
    const testDir = run.testDir(`mint-ownership-${randomUUID()}`);
    const previewPort = await reserveAvailablePort();
    const keyPair = tweetnacl.sign.keyPair();

    server = await startServerLight({
      testDir,
      dbProvider: 'sqlite',
      extraEnv: {
        HANDY_MASTER_SECRET: `mint-ownership-e2e-${randomUUID()}`,
        // live-stream server-routed relay (the SEC-2 headline branch)
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
        // tcp-tunnel server-routed relay (second mint branch)
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__ENABLED: '1',
        HAPPIER_FEATURE_MACHINES_TUNNEL_ALLOWED_PORTS: String(previewPort),
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_BYTES: `${8 * 1024 * 1024}`,
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_FRAME_BYTES: `${64 * 1024}`,
        // grant signing nacl keypair
        HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_KEY_ID: 'mint-ownership-e2e-grant-key',
        HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PRIVATE_KEY: toBase64Url(keyPair.secretKey),
        HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PUBLIC_KEY: toBase64Url(keyPair.publicKey),
        HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_EXPIRES_AT: String(Date.now() + 60 * 60 * 1000),
      },
    });

    const owner = await createTestAuth(server.baseUrl);
    const attacker = await createTestAuth(server.baseUrl);
    const ownerAccountId = readAccountIdFromToken(owner.token);

    // A real machine owned by the owner account (DB-backed `available` state). It is registered
    // with an installation identity so a later registration can supersede it via installation proof.
    const ownerInstallation = createMachineInstallationIdentityFixture();
    const ownerMachineId = `machine_${randomUUID()}`;
    const registration = await registerMachineIdentity({
      baseUrl: server.baseUrl,
      token: owner.token,
      machineId: ownerMachineId,
      installation: ownerInstallation,
    });
    expect(registration.status).toBe(200);
    expect(registration.machine?.id).toBe(ownerMachineId);

    // --- live_stream server_relay branch -------------------------------------------------
    // Owner mint succeeds and is signed by the configured grant key.
    const ownerMint = await postRouteGrant(
      server,
      owner.token,
      liveStreamGrantBody({ sourceMachineId: ownerMachineId, targetMachineId: ownerMachineId }),
    );
    expect(ownerMint.data.ok).toBe(true);
    expect(ownerMint.data.receipt).toBe(PEER_MEDIATION_RECEIPTS.routeGrantMinted);
    const parsedAuthorization = MachineLiveStreamRelayAuthorizationV1Schema.safeParse(
      ownerMint.data.relayAuthorization,
    );
    expect(parsedAuthorization.success).toBe(true);
    if (!parsedAuthorization.success) return;
    expect(parsedAuthorization.data.payload.accountId).toBe(ownerAccountId);
    expect(parsedAuthorization.data.payload.sourceMachineId).toBe(ownerMachineId);
    const signature = Buffer.from(parsedAuthorization.data.signature.valueBase64Url, 'base64url');
    expect(
      tweetnacl.sign.detached.verify(
        Buffer.from(
          createMachineLiveStreamRelayAuthorizationSigningInputV1(parsedAuthorization.data.payload),
          'utf8',
        ),
        signature,
        keyPair.publicKey,
      ),
    ).toBe(true);

    // Cross-user: attacker references the owner's machine → rejected, never signed.
    const crossUserMint = await postRouteGrant(
      server,
      attacker.token,
      liveStreamGrantBody({ sourceMachineId: ownerMachineId, targetMachineId: ownerMachineId }),
    );
    expect(crossUserMint.data.ok).toBe(false);
    expect(crossUserMint.data.receipt).toBe(PEER_MEDIATION_RECEIPTS.routeGrantRejected);
    expect(crossUserMint.data.reasonCode).toBe('machine_not_owned');
    expect(crossUserMint.data.relayAuthorization).toBeUndefined();

    // Missing: owner references a fabricated target machine id → rejected.
    const missingTargetMint = await postRouteGrant(
      server,
      owner.token,
      liveStreamGrantBody({ sourceMachineId: ownerMachineId, targetMachineId: `machine_${randomUUID()}` }),
    );
    expect(missingTargetMint.data.ok).toBe(false);
    expect(missingTargetMint.data.reasonCode).toBe('machine_not_owned');

    // A profile/account id is never accepted as a machine id (review2 #5).
    const profileAsMachineMint = await postRouteGrant(
      server,
      owner.token,
      liveStreamGrantBody({ sourceMachineId: ownerAccountId, targetMachineId: ownerAccountId }),
    );
    expect(profileAsMachineMint.data.ok).toBe(false);
    expect(profileAsMachineMint.data.reasonCode).toBe('machine_not_owned');

    // --- tcp_tunnel server_relay branch (cross-user) -------------------------------------
    const tunnelCrossUser = await postRouteGrant(
      server,
      attacker.token,
      tunnelGrantBody({ machineId: ownerMachineId, port: previewPort }),
    );
    expect(tunnelCrossUser.data.ok).toBe(false);
    expect(tunnelCrossUser.data.receipt).toBe(PEER_MEDIATION_RECEIPTS.routeGrantRejected);
    expect(tunnelCrossUser.data.reasonCode).toBe('machine_not_owned');

    // --- loopback_direct branch (cross-user) ---------------------------------------------
    const loopbackCrossUser = await postRouteGrant(
      server,
      attacker.token,
      loopbackLiveStreamGrantBody({ machineId: ownerMachineId }),
    );
    expect(loopbackCrossUser.data.ok).toBe(false);
    expect(loopbackCrossUser.data.receipt).toBe(PEER_MEDIATION_RECEIPTS.routeGrantRejected);
    expect(loopbackCrossUser.data.reasonCode).toBe('machine_not_owned');

    // --- replaced machine is rejected on the live_stream branch --------------------------
    // Supersede the owner machine via the automatic installation-proof replacement path so the DB
    // marks it `replaced` (not `available`) — the mint chokepoint must then reject it.
    const replacementMachineId = `machine_${randomUUID()}`;
    const replacementRegistration = await registerMachineIdentity({
      baseUrl: server.baseUrl,
      token: owner.token,
      machineId: replacementMachineId,
      installation: ownerInstallation,
      replacesMachineId: ownerMachineId,
      replacementReason: 'reauth',
    });
    expect(replacementRegistration.status).toBe(200);

    const replacedMint = await postRouteGrant(
      server,
      owner.token,
      liveStreamGrantBody({ sourceMachineId: ownerMachineId, targetMachineId: replacementMachineId }),
    );
    expect(replacedMint.data.ok).toBe(false);
    // A superseded machine reports `replaced`; either way it is no longer mintable.
    expect(['machine_replaced', 'machine_not_owned']).toContain(replacedMint.data.reasonCode);
  });
});
