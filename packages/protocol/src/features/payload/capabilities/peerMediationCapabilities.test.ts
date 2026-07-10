import { describe, expect, it } from 'vitest';

import { PeerMediationCapabilitiesSchema } from './peerMediationCapabilities.js';

describe('peer mediation capabilities payload', () => {
  it('defaults observability to unavailable and body capture off', () => {
    const parsed = PeerMediationCapabilitiesSchema.parse({});

    expect(parsed.observability.enabled).toBe(false);
    expect(parsed.observability.available).toBe(false);
    expect(parsed.observability.supportedFlowKinds).toEqual([]);
    expect(parsed.observability.bodyCapture).toBe('unavailable');
    expect(parsed.observability.payloadCapture).toBe('unavailable');
    expect(parsed.observability.publicPreviewScopedSummaries).toBe(false);
  });

  it('parses observability flow support and bounded retention details', () => {
    const parsed = PeerMediationCapabilitiesSchema.parse({
      observability: {
        enabled: true,
        available: true,
        supportedFlowKinds: ['tcp_tunnel', 'live_stream'],
        supportedEventKinds: ['flow.started', 'http.request.finished', 'websocket.closed'],
        retention: {
          perFlowEvents: 512,
          perMachineEvents: 2048,
          eventPayloadMaxBytes: 16_384,
          retentionWindowMs: 900_000,
          uiStoreMaxBytesPerMachine: 4_194_304,
          maxCounterSampleHz: 2,
        },
        sampling: {
          counterSampleHz: 2,
          throughputWindowMs: 1000,
        },
        publicPreviewScopedSummaries: true,
      },
    });

    expect(parsed.observability.supportedFlowKinds).toEqual(['tcp_tunnel', 'live_stream']);
    expect(parsed.observability.retention.maxCounterSampleHz).toBe(2);
    expect(parsed.observability.publicPreviewScopedSummaries).toBe(true);
  });

  it('rejects observability retention and sampling values above packet caps', () => {
    const result = PeerMediationCapabilitiesSchema.safeParse({
      observability: {
        retention: {
          perFlowEvents: 513,
          perMachineEvents: 2049,
          eventPayloadMaxBytes: 16_385,
          retentionWindowMs: 900_001,
          uiStoreMaxBytesPerMachine: 4_194_305,
          maxCounterSampleHz: 3,
        },
        sampling: {
          counterSampleHz: 3,
        },
      },
    });

    expect(result.success).toBe(false);
  });
});
