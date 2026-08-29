import { describe, expect, it } from 'vitest';
import { encodePeerTcpTunnelBinaryFrameForSession, decodePeerTcpTunnelBinaryFrameForSession } from './binaryCodec';

describe('duplex frame byte boundary', () => {
  it('round-trips moving bytes without a base64 representation', () => {
    const payload = new Uint8Array([0, 1, 2, 255]);
    const encoded = encodePeerTcpTunnelBinaryFrameForSession({
      v: 1, kind: 'data', tunnelId: 'tunnel', direction: 'client_to_daemon', sequence: 0, payload,
    });
    const decoded = decodePeerTcpTunnelBinaryFrameForSession({ frame: encoded, maxBinaryHeaderBytes: 4096, maxRawPayloadBytes: 4096 });
    expect(decoded.ok).toBe(true);
    if (decoded.ok && decoded.frame.kind === 'data') expect(decoded.frame.payload).toEqual(payload);
  });
});
