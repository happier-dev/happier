export class DaemonSpeechRelayDisconnectedError extends Error {
  readonly code = 'daemon_speech_relay_disconnected';

  constructor(readonly waitForReconnect?: (signal: AbortSignal) => Promise<boolean>) {
    super('daemon_speech_relay_disconnected');
  }
}
