type NativeSessionStrategyDependencies<TOptions, TConnection, TResult> = Readonly<{
  registerGlobals(): void;
  setSetupStrategy(
    strategy: (options: TOptions) => Promise<TResult>,
  ): void;
  createConnection(options: TOptions): Promise<TConnection>;
  setupWebRTCSession(connection: TConnection): TResult;
}>;

function rejectsReactNativeWebSocketSetup(options: unknown): boolean {
  if (!options || typeof options !== 'object' || Array.isArray(options)) return false;
  const { connectionType, signedUrl } = options as Readonly<{
    connectionType?: unknown;
    signedUrl?: unknown;
  }>;
  return connectionType === 'websocket' || typeof signedUrl === 'string';
}

/**
 * Installs the ElevenLabs WebRTC setup strategy for React Native.
 *
 * Native Voice's attempt already owns the LiveKit audio-session lease. This
 * adapter deliberately limits itself to LiveKit globals plus the provider
 * connection/controller setup, leaving attach/detach and audio-session
 * lifetime with their existing owners.
 */
export function installElevenLabsNativeSessionStrategy<TOptions, TConnection, TResult>(
  dependencies: NativeSessionStrategyDependencies<TOptions, TConnection, TResult>,
): void {
  dependencies.registerGlobals();
  dependencies.setSetupStrategy(async (options) => {
    if (rejectsReactNativeWebSocketSetup(options)) {
      throw new Error(
        'WebSocket connections are not supported on React Native. '
        + 'Only WebRTC connections are available. '
        + 'Remove the connectionType/signedUrl option or use connectionType: \'webrtc\'.',
      );
    }
    return dependencies.setupWebRTCSession(await dependencies.createConnection(options));
  });
}
