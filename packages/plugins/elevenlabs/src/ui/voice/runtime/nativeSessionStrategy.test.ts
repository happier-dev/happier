import { describe, expect, it, vi } from 'vitest';

import {
  installElevenLabsNativeSessionStrategy,
} from './nativeSessionStrategy.js';

describe('ElevenLabs native session setup strategy', () => {
  it('delegates WebRTC setup to the ElevenLabs media engine', async () => {
    const setSetupStrategy = vi.fn();
    const connection = Object.freeze({ kind: 'webrtc-connection' });
    const createConnection = vi.fn(async () => connection);
    const session = Object.freeze({
      connection,
      input: Object.freeze({}),
      output: Object.freeze({}),
      playbackEventTarget: null,
      detach: vi.fn(async () => undefined),
    });
    const setupWebRTCSession = vi.fn(() => session);

    installElevenLabsNativeSessionStrategy({
      setSetupStrategy,
      createConnection,
      setupWebRTCSession,
    });

    expect(setSetupStrategy).toHaveBeenCalledTimes(1);

    const strategy = setSetupStrategy.mock.calls[0]?.[0];
    if (typeof strategy !== 'function') throw new Error('native_strategy_not_registered');

    await expect(strategy({ connectionType: 'websocket' })).rejects.toThrow(
      'WebSocket connections are not supported on React Native',
    );
    await expect(strategy({ signedUrl: 'wss://example.test/conversation' })).rejects.toThrow(
      'WebSocket connections are not supported on React Native',
    );
    expect(createConnection).not.toHaveBeenCalled();

    await expect(strategy({ connectionType: 'webrtc' })).resolves.toBe(session);
    expect(createConnection).toHaveBeenCalledWith({ connectionType: 'webrtc' });
    expect(setupWebRTCSession).toHaveBeenCalledWith(connection);
    expect(session.detach).not.toHaveBeenCalled();
  });
});
