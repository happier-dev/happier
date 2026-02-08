export async function toggleLocalVoiceTurnWithTracking(params: {
  sessionId: string;
  toggleLocalVoiceTurn: (sessionId: string) => Promise<void>;
  getStatus: () => string;
  tracking?: { capture(event: string, props?: Record<string, unknown>): void } | null;
}): Promise<void> {
  const statusBefore = params.getStatus();
  await params.toggleLocalVoiceTurn(params.sessionId);
  const statusAfter = params.getStatus();

  params.tracking?.capture('voice_local_turn_toggled', {
    sessionId: params.sessionId,
    statusBefore,
    statusAfter,
  });
}
