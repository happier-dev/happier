import { SessionControlErrorCodeSchema } from '@happier-dev/protocol';

export type ControlCliMappedError = Readonly<{ code: string; unexpected: boolean; message?: string }>;

export function mapUnknownErrorToControlError(error: unknown): ControlCliMappedError {
  const anyErr = error as any;
  const rawCode = typeof anyErr?.code === 'string' ? anyErr.code : null;

  const known = new Set(SessionControlErrorCodeSchema.options);

  if (rawCode && known.has(rawCode)) {
    return { code: rawCode, unexpected: false, ...(error instanceof Error && error.message ? { message: error.message } : {}) };
  }

  // Common network failures from axios/node.
  if (rawCode === 'ECONNREFUSED' || rawCode === 'ECONNRESET' || rawCode === 'ENOTFOUND' || rawCode === 'EAI_AGAIN') {
    return { code: 'server_unreachable', unexpected: false, ...(error instanceof Error && error.message ? { message: error.message } : {}) };
  }

  const message = error instanceof Error ? error.message : String(error ?? '');
  const lower = message.toLowerCase();

  if (
    lower.startsWith('usage:') ||
    lower.startsWith('missing ') ||
    lower.includes('missing required') ||
    lower.includes('non-interactive mode') ||
    lower.includes('unknown ')
  ) {
    return { code: 'invalid_arguments', unexpected: false, ...(message ? { message } : {}) };
  }
  if (lower.includes('unauthorized') || lower.includes('forbidden')) {
    return { code: 'not_authenticated', unexpected: false, ...(message ? { message } : {}) };
  }
  if (lower.includes('timeout')) {
    return { code: 'timeout', unexpected: false, ...(message ? { message } : {}) };
  }

  return { code: 'unknown_error', unexpected: true, ...(message ? { message } : {}) };
}
