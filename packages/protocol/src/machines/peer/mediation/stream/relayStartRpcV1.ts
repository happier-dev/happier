import { lazyZodSchema } from '../../../../lazyZodSchema.js';
import { z } from 'zod/mini';

import { MachineLiveStreamStartRequestV1Schema } from './v1.js';
import { MachineLiveStreamSourceAdmissionV1Schema } from './sourceAdmissionV1.js';

export const DaemonMachineLiveStreamSourceAdmitRequestV1Schema = lazyZodSchema(() => z.strictObject({
    protocolVersion: z.literal(1),
    machineId: z.string().check(z.minLength(1)),
    sourceId: z.string().check(z.minLength(1)),
    streamFamily: z.string().check(z.minLength(1)),
}));
export type DaemonMachineLiveStreamSourceAdmitRequestV1 = z.infer<typeof DaemonMachineLiveStreamSourceAdmitRequestV1Schema>;

export const DaemonMachineLiveStreamSourceAdmitResponseV1Schema = lazyZodSchema(() => z.strictObject({
    protocolVersion: z.literal(1),
    result: z.discriminatedUnion('ok', [
        z.strictObject({ ok: z.literal(true), sourceAdmission: MachineLiveStreamSourceAdmissionV1Schema }),
        z.strictObject({ ok: z.literal(false), reasonCode: z.string().check(z.minLength(1)) }),
    ]),
}));
export type DaemonMachineLiveStreamSourceAdmitResponseV1 = z.infer<typeof DaemonMachineLiveStreamSourceAdmitResponseV1Schema>;

/**
 * Machine-RPC contract for triggering a server-relayed live-stream capture on the source
 * daemon (SIM-P0-1 fix).
 * The UI carries the server-minted start to the capture daemon over Machine RPC; the daemon
 * echoes it on its installed source socket, where the server verifies the relay authorization.
 * Raw DAEMON_LIVE_STREAM_RELAY_START requires Manage. Its v1 grant mint remains
 * custodian-only; the raw request retains host-display authority. The additive personal
 * method admits Use callers and requires the closed v2 carrier, whose Home signature and
 * exact personal source occurrence are verified before capture. Both methods use this
 * request/response contract and the existing relay terminator.
 */
export const DaemonMachineLiveStreamRelayStartRequestV1Schema = lazyZodSchema(() => z.strictObject({
    protocolVersion: z.literal(1),
    machineId: z.string().check(z.minLength(1)),
    startRequest: MachineLiveStreamStartRequestV1Schema,
  }));
export type DaemonMachineLiveStreamRelayStartRequestV1 = z.infer<
  typeof DaemonMachineLiveStreamRelayStartRequestV1Schema
>;

export const DaemonMachineLiveStreamRelayStartResponseV1Schema = lazyZodSchema(() => z.strictObject({
    protocolVersion: z.literal(1),
    result: z.discriminatedUnion('ok', [
      z.strictObject({ ok: z.literal(true), streamId: z.string().check(z.minLength(1)) }),
      z.strictObject({ ok: z.literal(false), reasonCode: z.string().check(z.minLength(1)) }),
    ]),
  }));
export type DaemonMachineLiveStreamRelayStartResponseV1 = z.infer<
  typeof DaemonMachineLiveStreamRelayStartResponseV1Schema
>;
