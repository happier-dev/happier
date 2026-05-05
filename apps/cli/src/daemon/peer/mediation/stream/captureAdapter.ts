import type {
  MachineLiveStreamCapsV1,
  MachineLiveStreamControlV1,
  MachineLiveStreamFrameV1,
  MachineLiveStreamReceiptV1,
  MachineLiveStreamStartRequestV1,
} from '@happier-dev/protocol';

export type MachineLiveStreamFrameOfferResult = Readonly<
  { ok: true } | { ok: false; reasonCode: string }
>;

export type MachineLiveStreamControlApplyResult = Readonly<
  { ok: true } | { ok: false; reasonCode: string }
>;

export type MachineLiveStreamCaptureSession = Readonly<{
  stop: () => void | Promise<void>;
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

export function createDaemonMachineLiveStreamCaptureAdapter(): MachineLiveStreamCaptureAdapter {
  return unavailableMachineLiveStreamCaptureAdapter;
}

export const unavailableMachineLiveStreamCaptureAdapter: MachineLiveStreamCaptureAdapter = {
  start: async () => ({
    ok: false,
    reasonCode: 'capture_unavailable',
  }),
};
