import { describe, expect, it } from 'vitest';
import type { Page } from '@playwright/test';
import {
  encodeBase64,
  encodePeerApplicationEncryptedFrameV1,
  encodePeerTcpTunnelBinaryFrameV2,
  type PeerApplicationEncryptionPhaseV1,
} from '@happier-dev/protocol';

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

function encryptedVoiceTunnelFrame(
  kind: PeerApplicationEncryptionPhaseV1,
  sequence: number,
  direction: 'client_to_daemon' | 'daemon_to_client' = 'client_to_daemon',
): Uint8Array {
  const encryptedPayload = encodePeerApplicationEncryptedFrameV1({
    v: 1,
    kind,
    nonceBase64Url: encodeBase64(new Uint8Array(12).fill(sequence + 1), 'base64url'),
    ciphertextBase64Url: encodeBase64(new Uint8Array(16).fill(sequence + 11), 'base64url'),
    ...(kind === 'install'
      ? { encryptedDataKeyEnvelopeBase64Url: encodeBase64(new Uint8Array([1, 2, 3]), 'base64url') }
      : null),
  });
  return encodePeerTcpTunnelBinaryFrameV2({
    header: {
      version: 2,
      kind: 'data',
      tunnelId: 'tunnel-1',
      substreamId: 'daemon.voiceInference.stt.stream-1.1',
      direction,
      sequence,
      payloadLength: encryptedPayload.byteLength,
    },
    payload: encryptedPayload,
  });
}

describe('observeVoiceRelaySocketTraffic', () => {
  it('classifies encrypted Voice relay phases and retains only counts and attachment digests', () => {
    const page = createEventTargetHarness();
    const websocket = createEventTargetHarness();
    // This fixture implements only the Playwright event boundary consumed by the observer.
    const observation = observeVoiceRelaySocketTraffic(page.target as unknown as Page);
    page.emit('websocket', websocket.target);

    websocket.emit('framesent', { payload: '451-["unrelated",{"_placeholder":true,"num":0}]' });
    websocket.emit('framesent', { payload: Buffer.from('unrelated bytes') });
    for (const [sequence, kind] of ['install', 'data', 'finish'].entries()) {
      websocket.emit('framesent', {
        payload: '451-["peer:tunnel:v1",{"v":2,"encoding":"binary_frame_v2","frame":{"_placeholder":true,"num":0}}]',
      });
      websocket.emit('framesent', {
        payload: Buffer.from(encryptedVoiceTunnelFrame(kind as PeerApplicationEncryptionPhaseV1, sequence)),
      });
    }
    websocket.emit('framereceived', {
      payload: '451-["peer:tunnel:v1",{"v":2,"encoding":"binary_frame_v2","frame":{"_placeholder":true,"num":0}}]',
    });
    websocket.emit('framereceived', {
      payload: Buffer.from(encryptedVoiceTunnelFrame('install', 0, 'daemon_to_client')),
    });

    expect(observation.snapshot()).toMatchObject({
      sawRelayEventName: true,
      sawBinaryFrameV2Header: true,
      binaryAttachmentCount: 3,
      validTunnelFrameCount: 3,
      invalidTunnelFrameCount: 0,
      voiceEncryptedInstallCount: 1,
      voiceEncryptedDataCount: 1,
      voiceEncryptedFinishCount: 1,
      invalidVoicePayloadCount: 0,
      receivedBinaryAttachmentCount: 1,
      receivedValidTunnelFrameCount: 1,
      receivedVoiceEncryptedInstallCount: 1,
    });
    expect(observation.snapshot().voicePayloadSha256Digests).toHaveLength(3);
    expect(observation.snapshot().voicePayloadSha256Digests).toEqual(
      expect.arrayContaining([expect.stringMatching(/^sha256:[0-9a-f]{64}$/u)]),
    );
  });

  it('rejects raw or undecodable payload on the Voice STT substream', () => {
    const page = createEventTargetHarness();
    const websocket = createEventTargetHarness();
    const observation = observeVoiceRelaySocketTraffic(page.target as unknown as Page);
    page.emit('websocket', websocket.target);

    const rawVoiceFrame = encodePeerTcpTunnelBinaryFrameV2({
      header: {
        version: 2,
        kind: 'data',
        tunnelId: 'tunnel-1',
        substreamId: 'daemon.voiceInference.stt.stream-1.1',
        direction: 'client_to_daemon',
        sequence: 1,
        payloadLength: 4,
      },
      payload: new Uint8Array([1, 2, 3, 4]),
    });
    websocket.emit('framesent', {
      payload: '451-["peer:tunnel:v1",{"v":2,"encoding":"binary_frame_v2","frame":{"_placeholder":true,"num":0}}]',
    });
    websocket.emit('framesent', { payload: Buffer.from(rawVoiceFrame) });
    websocket.emit('framesent', {
      payload: '451-["peer:tunnel:v1",{"v":2,"encoding":"binary_frame_v2","frame":{"_placeholder":true,"num":0}}]',
    });
    websocket.emit('framesent', { payload: Buffer.from([1, 2, 3, 4]) });

    expect(observation.snapshot()).toMatchObject({
      validTunnelFrameCount: 1,
      invalidTunnelFrameCount: 1,
      invalidVoicePayloadCount: 1,
      voiceEncryptedInstallCount: 0,
      voiceEncryptedDataCount: 0,
      voiceEncryptedFinishCount: 0,
    });
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
      voiceEncryptedInstallCount: 0,
      voiceEncryptedDataCount: 0,
      voiceEncryptedFinishCount: 0,
      invalidVoicePayloadCount: 0,
      voicePayloadSha256Digests: [],
      receivedBinaryAttachmentCount: 0,
      receivedBinaryAttachmentBytes: 0,
      receivedValidTunnelFrameCount: 0,
      receivedInvalidTunnelFrameCount: 0,
      receivedVoiceEncryptedInstallCount: 0,
      receivedVoiceEncryptedDataCount: 0,
      receivedVoiceEncryptedFinishCount: 0,
      receivedInvalidVoicePayloadCount: 0,
    });
  });
});
