import { describe, expect, it } from 'vitest';

import type { MachineLiveStreamFrameV1 } from '@happier-dev/protocol';

import {
  createDaemonMachineLiveStreamCaptureAdapter,
  type MachineLiveStreamCaptureAdapter,
} from './captureAdapter';
import { createMachineLiveStreamCaptureRegistry } from './captureRegistry';

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

  it('can resolve a registered capture source through the daemon capture adapter', async () => {
    const registry = createMachineLiveStreamCaptureRegistry();
    const sourceAdapter: MachineLiveStreamCaptureAdapter = {
      start: async (input) => {
        input.offerFrame({
          v: 1,
          streamId: input.streamId,
          sequence: 1,
          timestampMs: 1_000,
          payloadKind: 'image_keyframe',
          payloadEncoding: 'binary_base64',
          payloadBase64: 'AQID',
          payloadSizeBytes: 3,
        });
        return { ok: true, session: { stop: () => undefined } };
      },
    };
    registry.register({
      sourceId: 'source_1',
      streamFamily: 'screen',
      adapter: sourceAdapter,
      capabilities: {
        v: 1,
        sourceId: 'source_1',
        sourceKind: 'screen',
        supportedCodecs: ['image.mjpeg'],
        maxFramesPerSecond: 12,
        inputMode: 'exclusive',
        sidebands: [],
        health: { status: 'available' },
      },
    });
    const offeredFrames: MachineLiveStreamFrameV1[] = [];
    const adapter = createDaemonMachineLiveStreamCaptureAdapter(registry);

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

    expect(result).toMatchObject({ ok: true });
    expect(offeredFrames.map((frame) => frame.sequence)).toEqual([1]);
  });
});
