import { describe, expect, it } from 'vitest';
import type { Page } from '@playwright/test';
import { encodePeerTcpTunnelBinaryFrameV2 } from '@happier-dev/protocol';

import { observeVoiceRelaySocketTraffic } from './voiceRelaySocketTrafficObservation';

type Handler = (value: unknown) => void;

function createEventTargetHarness() {
  const handlers = new Map<string, Handler[]>();
  const target = {
    on(event: string, handler: Handler) {
      const current = handlers.get(event) ?? [];
      current.push(handler);
      handlers.set(event, current);
      return target;
    },
  };
  return {
    target,
    emit(event: string, value: unknown) {
      for (const handler of handlers.get(event) ?? []) handler(value);
    },
  };
}

function voiceTunnelFrame(
  payload: Uint8Array,
  sequence: number,
  direction: 'client_to_daemon' | 'daemon_to_client' = 'client_to_daemon',
): Uint8Array {
  return encodePeerTcpTunnelBinaryFrameV2({
    header: {
      version: 2,
      kind: 'data',
      tunnelId: 'tunnel-1',
      substreamId: 'daemon.voiceInference.stt.stream-1.1',
      direction,
      sequence,
      payloadLength: payload.byteLength,
    },
    payload,
  });
}

describe('observeVoiceRelaySocketTraffic', () => {
  it('counts Voice relay payloads, separates plain JSON responses and retains only counts and digests', () => {
    const page = createEventTargetHarness();
    const websocket = createEventTargetHarness();
    // This fixture implements only the Playwright event boundary consumed by the observer.
    const observation = observeVoiceRelaySocketTraffic(page.target as unknown as Page);
    page.emit('websocket', websocket.target);
    const header = '451-["peer:tunnel:v1",{"v":2,"encoding":"binary_frame_v2","frame":{"_placeholder":true,"num":0}}]';

    websocket.emit('framesent', { payload: '451-["unrelated",{"_placeholder":true,"num":0}]' });
    websocket.emit('framesent', { payload: Buffer.from('unrelated bytes') });
    for (const sequence of [0, 1]) {
      websocket.emit('framesent', { payload: header });
      websocket.emit('framesent', { payload: Buffer.from(voiceTunnelFrame(new Uint8Array(20).fill(sequence + 7), sequence)) });
    }
    websocket.emit('framesent', { payload: header });
    websocket.emit('framesent', { payload: Buffer.from([1, 2, 3, 4]) });
    websocket.emit('framereceived', { payload: header });
    websocket.emit('framereceived', { payload: Buffer.from(voiceTunnelFrame(new Uint8Array(20).fill(9), 0, 'daemon_to_client')) });
    websocket.emit('framereceived', { payload: header });
    websocket.emit('framereceived', { payload: Buffer.from(voiceTunnelFrame(
      new TextEncoder().encode(JSON.stringify({ ok: true, ackSeq: 1, events: [] })), 1, 'daemon_to_client')) });

    expect(observation.snapshot()).toMatchObject({
      sawRelayEventName: true,
      sawBinaryFrameV2Header: true,
      binaryAttachmentCount: 3,
      validTunnelFrameCount: 2,
      invalidTunnelFrameCount: 1,
      voiceDataFrameCount: 2,
      receivedBinaryAttachmentCount: 2,
      receivedValidTunnelFrameCount: 2,
      receivedVoiceDataFrameCount: 2,
      receivedPlainJsonVoicePayloadCount: 1,
    });
    expect(observation.snapshot().voicePayloadSha256Digests).toHaveLength(2);
    expect(observation.snapshot().voicePayloadSha256Digests).toEqual(
      expect.arrayContaining([expect.stringMatching(/^sha256:[0-9a-f]{64}$/u)]),
    );
  });

  it('keeps the direct-route observation empty when no relay event is sent', () => {
    const page = createEventTargetHarness();
    const websocket = createEventTargetHarness();
    // This fixture implements only the Playwright event boundary consumed by the observer.
    const observation = observeVoiceRelaySocketTraffic(page.target as unknown as Page);
    page.emit('websocket', websocket.target);
    websocket.emit('framesent', { payload: '42["rpc-call",{"method":"daemon.voiceInference.status"}]' });

    expect(observation.snapshot()).toEqual({
      sawRelayEventName: false,
      sawBinaryFrameV2Header: false,
      binaryAttachmentCount: 0,
      binaryAttachmentBytes: 0,
      validTunnelFrameCount: 0,
      invalidTunnelFrameCount: 0,
      voiceDataFrameCount: 0,
      voicePayloadSha256Digests: [],
      receivedBinaryAttachmentCount: 0,
      receivedBinaryAttachmentBytes: 0,
      receivedValidTunnelFrameCount: 0,
      receivedInvalidTunnelFrameCount: 0,
      receivedVoiceDataFrameCount: 0,
      receivedPlainJsonVoicePayloadCount: 0,
    });
  });
});
