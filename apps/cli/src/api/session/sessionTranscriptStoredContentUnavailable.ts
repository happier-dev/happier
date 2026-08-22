import { createHttpStatusError, type HttpStatusError } from '@/api/client/httpStatusError';

export const SESSION_TRANSCRIPT_STORED_CONTENT_UNAVAILABLE_ERROR_CODE =
  'session_transcript_stored_content_unavailable' as const;

export type SessionTranscriptStoredContentUnavailableError = HttpStatusError & Readonly<{
  code: typeof SESSION_TRANSCRIPT_STORED_CONTENT_UNAVAILABLE_ERROR_CODE;
}>;

function isUnavailableResponseData(data: unknown): boolean {
  return Boolean(
    data
    && typeof data === 'object'
    && !Array.isArray(data)
    && (data as { error?: unknown }).error
      === SESSION_TRANSCRIPT_STORED_CONTENT_UNAVAILABLE_ERROR_CODE,
  );
}

export function createSessionTranscriptStoredContentUnavailableError(): SessionTranscriptStoredContentUnavailableError {
  return createHttpStatusError(
    503,
    'Session transcript stored content is unavailable',
    SESSION_TRANSCRIPT_STORED_CONTENT_UNAVAILABLE_ERROR_CODE,
  ) as SessionTranscriptStoredContentUnavailableError;
}

export function throwIfSessionTranscriptStoredContentUnavailableResponse(
  status: unknown,
  data: unknown,
): void {
  if (status === 503 && isUnavailableResponseData(data)) {
    throw createSessionTranscriptStoredContentUnavailableError();
  }
}

export function rethrowSessionTranscriptStoredContentUnavailableResponse(error: unknown): never {
  const unavailable = resolveSessionTranscriptStoredContentUnavailableError(error);
  if (unavailable) throw unavailable;
  throw error;
}

export function resolveSessionTranscriptStoredContentUnavailableError(
  error: unknown,
): SessionTranscriptStoredContentUnavailableError | null {
  if (error && typeof error === 'object') {
    if (
      (error as { code?: unknown }).code
      === SESSION_TRANSCRIPT_STORED_CONTENT_UNAVAILABLE_ERROR_CODE
    ) {
      return error as SessionTranscriptStoredContentUnavailableError;
    }
    const response = (error as { response?: unknown }).response;
    if (response && typeof response === 'object') {
      const status = (response as { status?: unknown }).status;
      const data = (response as { data?: unknown }).data;
      if (status === 503 && isUnavailableResponseData(data)) {
        return createSessionTranscriptStoredContentUnavailableError();
      }
    }
  }
  return null;
}
