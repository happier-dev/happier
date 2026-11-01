export type SttRequestErrorCode = 'stt_auth_failed' | 'stt_rate_limited' | 'stt_failed';

/**
 * A transcription request the STT service answered with an HTTP error. `code` is the
 * local-voice error code surfaced to the user; `status` keeps the raw detail.
 */
export class SttRequestError extends Error {
  readonly code: SttRequestErrorCode;
  readonly status: number;

  constructor(params: { provider: string; status: number; code?: SttRequestErrorCode }) {
    super(`${params.provider}_stt_failed:${params.status}`);
    this.name = 'SttRequestError';
    this.status = params.status;
    this.code = params.code ?? classifySttHttpStatus(params.status);
  }
}

export function classifySttHttpStatus(status: number): SttRequestErrorCode {
  if (status === 401 || status === 403) return 'stt_auth_failed';
  if (status === 429) return 'stt_rate_limited';
  return 'stt_failed';
}

export function resolveSttFailureCode(error: unknown): SttRequestErrorCode | 'stt_timeout' {
  if (error instanceof SttRequestError) return error.code;
  if (error instanceof Error && error.message === 'stt_timeout') return 'stt_timeout';
  return 'stt_failed';
}
