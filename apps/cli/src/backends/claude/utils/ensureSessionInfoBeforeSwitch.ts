export async function ensureSessionInfoBeforeSwitch(params: {
  session: {
    sessionId: string | null;
    transcriptPath: string | null;
    client: {
      sendSessionEvent: (event: { type: 'message'; message: string }) => void;
    };
    waitForSessionFound: (opts: { timeoutMs: number; requireTranscriptPath: boolean }) => Promise<unknown>;
  };
}): Promise<void> {
  const needsSessionId = params.session.sessionId === null;
  const needsTranscriptPath = params.session.transcriptPath === null;
  if (!needsSessionId && !needsTranscriptPath) return;

  params.session.client.sendSessionEvent({
    type: 'message',
    message: needsSessionId
      ? 'Waiting for Claude session to initialize before switching…'
      : 'Waiting for Claude transcript info before switching…',
  });

  await params.session.waitForSessionFound({
    timeoutMs: 2000,
    requireTranscriptPath: needsTranscriptPath,
  });
}
