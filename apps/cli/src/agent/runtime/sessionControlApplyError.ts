export type SessionControlApplyFailureKind = 'definitive' | 'retryable';

export class SessionControlApplyError extends Error {
  readonly kind: SessionControlApplyFailureKind;
  readonly cause: unknown;

  constructor(kind: SessionControlApplyFailureKind, cause: unknown) {
    super(cause instanceof Error ? cause.message : 'Session control update failed');
    this.name = 'SessionControlApplyError';
    this.kind = kind;
    this.cause = cause;
  }

  static definitive(cause: unknown): SessionControlApplyError {
    return new SessionControlApplyError('definitive', cause);
  }
}

export function isDefinitiveSessionControlApplyError(error: unknown): boolean {
  return error instanceof SessionControlApplyError && error.kind === 'definitive';
}
