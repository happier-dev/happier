import { z } from 'zod';

import { MachineLiveStreamStartRequestV1Schema } from './v1.js';

/**
 * Machine-RPC contract for triggering a server-relayed live-stream capture on the source
 * daemon (SIM-P0-1 fix).
 *
 * Why this exists: the relay socket handler only accepts `start` envelopes from the SOURCE
 * machine-scoped socket (viewer-sent starts are rejected with `source_machine_mismatch`), and
 * nothing else forwarded the viewer's signed start to the daemon — so the server-relay route
 * could never begin producing. The UI now carries the server-minted, signed
 * `MachineLiveStreamStartRequestV1` to the capture daemon over the canonical machine-RPC
 * channel (`RPC_METHODS.DAEMON_LIVE_STREAM_RELAY_START`); the daemon's relay terminator starts
 * capture and echoes the start on its own machine-scoped socket, where the server verifies the
 * Ed25519 relay authorization exactly as before. The signature remains server-verified — this
 * RPC only moves the already-signed request to the machine that must act on it, over a channel
 * that is itself account-scoped (only the owning account can RPC its machines).
 */
export const DaemonMachineLiveStreamRelayStartRequestV1Schema = z
  .object({
    protocolVersion: z.literal(1),
    machineId: z.string().min(1),
    startRequest: MachineLiveStreamStartRequestV1Schema,
  })
  .strict();
export type DaemonMachineLiveStreamRelayStartRequestV1 = z.infer<
  typeof DaemonMachineLiveStreamRelayStartRequestV1Schema
>;

export const DaemonMachineLiveStreamRelayStartResponseV1Schema = z
  .object({
    protocolVersion: z.literal(1),
    result: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), streamId: z.string().min(1) }).strict(),
      z.object({ ok: z.literal(false), reasonCode: z.string().min(1) }).strict(),
    ]),
  })
  .strict();
export type DaemonMachineLiveStreamRelayStartResponseV1 = z.infer<
  typeof DaemonMachineLiveStreamRelayStartResponseV1Schema
>;
