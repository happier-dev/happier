import type { Page } from '@playwright/test';
import {
  decodePeerApplicationEncryptedFrameV1,
  decodePeerTcpTunnelBinaryFrameV2,
} from '@happier-dev/protocol';
import { createHash } from 'node:crypto';

const VOICE_STT_SUBSTREAM_PREFIX = 'daemon.voiceInference.stt.';
const MAX_OBSERVED_TUNNEL_FRAME_BYTES = 2 * 1024 * 1024;
const MAX_RETAINED_DIGESTS = 2_048;

export type VoiceRelaySocketTrafficObservation = Readonly<{
  sawRelayEventName: () => boolean;
  sawBinaryFrameV2Header: () => boolean;
  binaryAttachmentCount: () => number;
  binaryAttachmentBytes: () => number;
  snapshot: () => Readonly<{
    sawRelayEventName: boolean;
    sawBinaryFrameV2Header: boolean;
    binaryAttachmentCount: number;
    binaryAttachmentBytes: number;
    validTunnelFrameCount: number;
    invalidTunnelFrameCount: number;
    voiceEncryptedInstallCount: number;
    voiceEncryptedDataCount: number;
    voiceEncryptedFinishCount: number;
    invalidVoicePayloadCount: number;
    voicePayloadSha256Digests: readonly string[];
    receivedBinaryAttachmentCount: number;
    receivedBinaryAttachmentBytes: number;
    receivedValidTunnelFrameCount: number;
    receivedInvalidTunnelFrameCount: number;
    receivedVoiceEncryptedInstallCount: number;
    receivedVoiceEncryptedDataCount: number;
    receivedVoiceEncryptedFinishCount: number;
    receivedInvalidVoicePayloadCount: number;
  }>;
}>;

/**
 * Observes only the browser's raw Socket.IO transport frames that are sent to
 * the server. It intentionally retains counts/byte lengths, not Voice bytes.
 */
export function observeVoiceRelaySocketTraffic(page: Page): VoiceRelaySocketTrafficObservation {
  let sawRelayEventName = false;
  let sawBinaryFrameV2Header = false;
  let pendingBinaryAttachments = 0;
  let binaryAttachmentCount = 0;
  let binaryAttachmentBytes = 0;
  let validTunnelFrameCount = 0;
  let invalidTunnelFrameCount = 0;
  let voiceEncryptedInstallCount = 0;
  let voiceEncryptedDataCount = 0;
  let voiceEncryptedFinishCount = 0;
  let invalidVoicePayloadCount = 0;
  let pendingReceivedBinaryAttachments = 0;
  let receivedBinaryAttachmentCount = 0;
  let receivedBinaryAttachmentBytes = 0;
  let receivedValidTunnelFrameCount = 0;
  let receivedInvalidTunnelFrameCount = 0;
  let receivedVoiceEncryptedInstallCount = 0;
  let receivedVoiceEncryptedDataCount = 0;
  let receivedVoiceEncryptedFinishCount = 0;
  let receivedInvalidVoicePayloadCount = 0;
  const voicePayloadSha256Digests: string[] = [];

  page.on('websocket', (websocket) => {
    websocket.on('framesent', ({ payload }) => {
      if (typeof payload === 'string') {
        const isVoiceRelayHeader = payload.includes('peer:tunnel:v1')
          && payload.includes('binary_frame_v2');
        if (payload.includes('peer:tunnel:v1')) {
          sawRelayEventName = true;
        }
        if (payload.includes('binary_frame_v2')) {
          sawBinaryFrameV2Header = true;
        }
        if (isVoiceRelayHeader) {
          const binaryPacket = payload.match(/^45(\d+)-/);
          if (binaryPacket) {
            pendingBinaryAttachments += Number(binaryPacket[1] ?? 0);
          }
        }
        return;
      }
      if (pendingBinaryAttachments <= 0) return;
      pendingBinaryAttachments -= 1;
      binaryAttachmentCount += 1;
      binaryAttachmentBytes += payload.byteLength;
      const bytes = new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
      const decodedTunnelFrame = decodePeerTcpTunnelBinaryFrameV2({
        frame: bytes,
        maxHeaderBytes: MAX_OBSERVED_TUNNEL_FRAME_BYTES,
        maxPayloadBytes: MAX_OBSERVED_TUNNEL_FRAME_BYTES,
      });
      if (!decodedTunnelFrame.ok) {
        invalidTunnelFrameCount += 1;
        return;
      }
      validTunnelFrameCount += 1;
      if (
        decodedTunnelFrame.header.kind !== 'data'
        || decodedTunnelFrame.header.direction !== 'client_to_daemon'
        || !decodedTunnelFrame.header.substreamId?.startsWith(VOICE_STT_SUBSTREAM_PREFIX)
      ) {
        return;
      }

      const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
      if (voicePayloadSha256Digests.length < MAX_RETAINED_DIGESTS) {
        voicePayloadSha256Digests.push(digest);
      }
      const encryptedFrame = decodePeerApplicationEncryptedFrameV1(decodedTunnelFrame.payload);
      if (!encryptedFrame) {
        invalidVoicePayloadCount += 1;
        return;
      }
      if (encryptedFrame.kind === 'install') {
        voiceEncryptedInstallCount += 1;
      } else if (encryptedFrame.kind === 'data') {
        voiceEncryptedDataCount += 1;
      } else {
        voiceEncryptedFinishCount += 1;
      }
    });
    websocket.on('framereceived', ({ payload }) => {
      if (typeof payload === 'string') {
        if (payload.includes('peer:tunnel:v1') && payload.includes('binary_frame_v2')) {
          const binaryPacket = payload.match(/^45(\d+)-/);
          if (binaryPacket) pendingReceivedBinaryAttachments += Number(binaryPacket[1] ?? 0);
        }
        return;
      }
      if (pendingReceivedBinaryAttachments <= 0) return;
      pendingReceivedBinaryAttachments -= 1;
      receivedBinaryAttachmentCount += 1;
      receivedBinaryAttachmentBytes += payload.byteLength;
      const bytes = new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
      const decodedTunnelFrame = decodePeerTcpTunnelBinaryFrameV2({
        frame: bytes,
        maxHeaderBytes: MAX_OBSERVED_TUNNEL_FRAME_BYTES,
        maxPayloadBytes: MAX_OBSERVED_TUNNEL_FRAME_BYTES,
      });
      if (!decodedTunnelFrame.ok) {
        receivedInvalidTunnelFrameCount += 1;
        return;
      }
      receivedValidTunnelFrameCount += 1;
      if (
        decodedTunnelFrame.header.kind !== 'data'
        || decodedTunnelFrame.header.direction !== 'daemon_to_client'
        || !decodedTunnelFrame.header.substreamId?.startsWith(VOICE_STT_SUBSTREAM_PREFIX)
      ) {
        return;
      }
      const encryptedFrame = decodePeerApplicationEncryptedFrameV1(decodedTunnelFrame.payload);
      if (!encryptedFrame) {
        receivedInvalidVoicePayloadCount += 1;
      } else if (encryptedFrame.kind === 'install') {
        receivedVoiceEncryptedInstallCount += 1;
      } else if (encryptedFrame.kind === 'data') {
        receivedVoiceEncryptedDataCount += 1;
      } else {
        receivedVoiceEncryptedFinishCount += 1;
      }
    });
  });

  return {
    sawRelayEventName: () => sawRelayEventName,
    sawBinaryFrameV2Header: () => sawBinaryFrameV2Header,
    binaryAttachmentCount: () => binaryAttachmentCount,
    binaryAttachmentBytes: () => binaryAttachmentBytes,
    snapshot: () => ({
      sawRelayEventName,
      sawBinaryFrameV2Header,
      binaryAttachmentCount,
      binaryAttachmentBytes,
      validTunnelFrameCount,
      invalidTunnelFrameCount,
      voiceEncryptedInstallCount,
      voiceEncryptedDataCount,
      voiceEncryptedFinishCount,
      invalidVoicePayloadCount,
      voicePayloadSha256Digests: [...voicePayloadSha256Digests],
      receivedBinaryAttachmentCount,
      receivedBinaryAttachmentBytes,
      receivedValidTunnelFrameCount,
      receivedInvalidTunnelFrameCount,
      receivedVoiceEncryptedInstallCount,
      receivedVoiceEncryptedDataCount,
      receivedVoiceEncryptedFinishCount,
      receivedInvalidVoicePayloadCount,
    }),
  };
}
