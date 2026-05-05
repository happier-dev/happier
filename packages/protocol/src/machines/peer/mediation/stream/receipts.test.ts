import { describe, expect, it } from 'vitest';

import { PEER_MEDIATION_RECEIPTS } from '../receipts';
import { MachineLiveStreamReceiptV1Schema } from './receipts';

describe('MachineLiveStreamReceiptV1Schema', () => {
  it('accepts stream lifecycle receipts with metering details', () => {
    const parsed = MachineLiveStreamReceiptV1Schema.parse({
      v: 1,
      id: PEER_MEDIATION_RECEIPTS.streamBandwidthCapped,
      streamId: 'stream_1',
      routeKind: 'server_relay',
      flowKind: 'live_stream',
      reasonCode: 'max_total_bytes_exceeded',
      bytesSent: 8,
      bytesRelayed: 8,
      bytesDropped: 0,
      framesSent: 1,
      framesDropped: 0,
      maxBitrateBps: 64_000,
      maxFramesPerSecond: 12,
      maxFrameBytes: 32_000,
      maxDurationMs: 60_000,
      maxTotalBytes: 8,
    });

    expect(parsed.id).toBe('peer.stream.bandwidth_capped');
    expect(parsed.flowKind).toBe('live_stream');
  });

  it('rejects frame payload, grant, and nonce details', () => {
    const unsafe = {
      v: 1,
      id: PEER_MEDIATION_RECEIPTS.streamPaused,
      streamId: 'stream_1',
      routeKind: 'server_relay',
      flowKind: 'live_stream',
      reasonCode: 'backpressure_window_exhausted',
      payloadBase64: 'c2VudGluZWw=',
    } as const;

    expect(MachineLiveStreamReceiptV1Schema.safeParse(unsafe).success).toBe(false);
    expect(MachineLiveStreamReceiptV1Schema.safeParse({
      ...unsafe,
      payloadBase64: undefined,
      grantToken: 'secret',
    }).success).toBe(false);
    expect(MachineLiveStreamReceiptV1Schema.safeParse({
      ...unsafe,
      payloadBase64: undefined,
      nonceBase64Url: 'nonce',
    }).success).toBe(false);
  });
});
