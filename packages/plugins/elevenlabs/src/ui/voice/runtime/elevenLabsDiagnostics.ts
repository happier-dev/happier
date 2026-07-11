export function createElevenLabsDiagnostics(input: Readonly<{
  appendSystem: (message: string) => void;
  appendProviderPayload: (payload: unknown) => void;
  appendError: (reason: string) => void;
}>) {
  return Object.freeze({
    connected(): void {
      input.appendSystem('Realtime ElevenLabs session connected');
    },
    disconnected(): void {
      input.appendSystem('Realtime ElevenLabs session disconnected');
    },
    providerEvent(payload: unknown): void {
      input.appendProviderPayload(payload);
    },
    error(reason: string): void {
      input.appendError(reason);
    },
  });
}

export type ElevenLabsDiagnostics = ReturnType<typeof createElevenLabsDiagnostics>;
