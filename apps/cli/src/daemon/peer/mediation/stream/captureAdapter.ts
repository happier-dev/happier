import type {
  MachineLiveStreamCapsV1,
  MachineLiveStreamControlSidebandV1,
  MachineLiveStreamControlV1,
  MachineLiveStreamFrameV1,
  MachineLiveStreamReceiptV1,
  MachineLiveStreamStartRequestV1,
  PeerMediationObservabilityEventKindV1,
} from '@happier-dev/protocol';

import type { MachineLiveStreamCaptureRegistry } from './captureRegistry';

/**
 * Canonical close-reason contract for capture sessions.
 *
 * A capture session signals why it ended through the `reasonCode` on its
 * terminal receipt. This is the single seam where those free-string reason
 * codes are mapped into the distinct PMS-9 observability close kind, so a clean
 * end-of-stream reads as `flow.closed`, an upstream/source abort as
 * `flow.aborted`, and every other terminal signal (cap breach, lease expiry,
 * capture failure, unknown) stays `flow.errored`.
 *
 * Concrete capture sources (e.g. the simulator scrcpy/helper adapters) own the
 * reason strings they emit; this contract is what the relay maps them into.
 * Keeping it here — at the adapter seam — means there is exactly one taxonomy
 * shared by the producer (capture sources) and the consumer (relay terminator),
 * rather than a magic-string set buried in the relay.
 */
export const CAPTURE_CLEAN_CLOSE_TERMINAL_REASON_CODES: ReadonlySet<string> = new Set([
  'android_scrcpy_raw_stream_ended',
  'capture_stopped',
  'capture_complete',
  'end_of_stream',
  'stream_complete',
]);

export const CAPTURE_ABORT_TERMINAL_REASON_CODES: ReadonlySet<string> = new Set([
  'android_scrcpy_raw_stream_unavailable',
  'upstream_abort',
  'downstream_abort',
  'capture_source_unavailable',
]);

/**
 * Map a capture-originated terminal receipt `reasonCode` into the distinct
 * observability close kind it deserves. The reason itself still travels verbatim
 * in `data.reasonCode`; this only resolves the lifecycle kind.
 */
export function classifyCaptureTerminalCloseKind(
  reasonCode: string | undefined,
): PeerMediationObservabilityEventKindV1 {
  if (reasonCode && CAPTURE_CLEAN_CLOSE_TERMINAL_REASON_CODES.has(reasonCode)) return 'flow.closed';
  if (reasonCode && CAPTURE_ABORT_TERMINAL_REASON_CODES.has(reasonCode)) return 'flow.aborted';
  return 'flow.errored';
}

export type MachineLiveStreamFrameOfferResult = Readonly<
  { ok: true } | { ok: false; reasonCode: string }
>;

export type MachineLiveStreamControlApplyResult = Readonly<
  { ok: true } | { ok: false; reasonCode: string }
>;

export type MachineLiveStreamCaptureSession = Readonly<{
  stop: () => void | Promise<void>;
  applySidebandControl?: (control: MachineLiveStreamControlSidebandV1) => MachineLiveStreamControlApplyResult;
}>;

export type MachineLiveStreamCaptureStartInput = Readonly<{
  streamId: string;
  streamFamily: string;
  sourceMachineId: string;
  targetMachineId: string;
  caps: MachineLiveStreamCapsV1;
  startRequest: MachineLiveStreamStartRequestV1;
  startedAtMs: number;
  expiresAtMs: number;
  nowMs: () => number;
  offerFrame: (frame: MachineLiveStreamFrameV1) => MachineLiveStreamFrameOfferResult;
  applyControl: (control: MachineLiveStreamControlV1) => MachineLiveStreamControlApplyResult;
  emitReceipt: (receipt: MachineLiveStreamReceiptV1) => void;
}>;

export type MachineLiveStreamCaptureStartResult = Readonly<
  | { ok: true; session: MachineLiveStreamCaptureSession }
  | { ok: false; reasonCode: string }
>;

export type MachineLiveStreamCaptureAdapter = Readonly<{
  start: (input: MachineLiveStreamCaptureStartInput) => Promise<MachineLiveStreamCaptureStartResult>;
}>;

export function createDaemonMachineLiveStreamCaptureAdapter(
  registry?: MachineLiveStreamCaptureRegistry,
): MachineLiveStreamCaptureAdapter {
  if (registry) {
    return {
      start: async (input) => {
        const source = registry.resolve({ streamFamily: input.streamFamily });
        if (!source.ok) {
          return {
            ok: false,
            reasonCode: source.diagnostic.reasonCode,
          };
        }
        return await source.source.adapter.start(input);
      },
    };
  }
  return unavailableMachineLiveStreamCaptureAdapter;
}

export const unavailableMachineLiveStreamCaptureAdapter: MachineLiveStreamCaptureAdapter = {
  start: async () => ({
    ok: false,
    reasonCode: 'capture_unavailable',
  }),
};
