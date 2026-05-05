import { describe, expect, it } from 'vitest';

import type { MachineLiveStreamFrameV1 } from '@happier-dev/protocol';

import { createDaemonMachineLiveStreamCaptureAdapter } from './captureAdapter';

describe('createDaemonMachineLiveStreamCaptureAdapter', () => {
  it('fails closed until a real daemon capture source is available', async () => {
    const offeredFrames: MachineLiveStreamFrameV1[] = [];
    const adapter = createDaemonMachineLiveStreamCaptureAdapter();

    const result = await adapter.start({
      streamId: 'stream_1',
      streamFamily: 'screen',
      sourceMachineId: 'machine_source',
      targetMachineId: 'machine_target',
      caps: {
        maxBitrateBps: 64_000,
        maxFramesPerSecond: 12,
        maxFrameBytes: 8_192,
        maxDurationMs: 60_000,
        maxTotalBytes: 128_000,
      },
      startRequest: {
        v: 1,
        streamId: 'stream_1',
        streamFamily: 'screen',
        routeKind: 'loopback_direct',
        sourceMachineId: 'machine_source',
        targetMachineId: 'machine_target',
        maxBitrateBps: 64_000,
        maxFramesPerSecond: 12,
        maxFrameBytes: 8_192,
        maxDurationMs: 60_000,
        maxTotalBytes: 128_000,
      },
      startedAtMs: 1_000,
      expiresAtMs: 61_000,
      nowMs: () => 1_000,
      offerFrame: (frame) => {
        offeredFrames.push(frame);
        return { ok: true };
      },
      applyControl: () => ({ ok: true }),
      emitReceipt: () => undefined,
    });

    expect(result).toEqual({
      ok: false,
      reasonCode: 'capture_unavailable',
    });
    expect(offeredFrames).toHaveLength(0);
  });
});
