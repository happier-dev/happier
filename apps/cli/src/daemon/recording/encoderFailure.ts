/** Missing executable is distinct from an encoder that failed to start. */
export class RecordingEncoderUnavailableError extends Error {
  readonly code = 'encoder_unavailable';

  constructor() {
    super('encoder_unavailable');
  }
}

export function recordingEncoderFailure(error: unknown): Readonly<{
  code: 'encoder_unavailable' | 'encoder_failed';
  message: string;
}> {
  const code = error instanceof RecordingEncoderUnavailableError
    ? 'encoder_unavailable'
    : 'encoder_failed';
  // Machine-readable diagnostics only; presenters own the source-specific copy.
  return { code, message: code };
}
