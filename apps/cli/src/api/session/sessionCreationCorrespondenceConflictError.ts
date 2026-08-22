/**
 * Exact immutable create-or-rejoin correspondence refusal.
 *
 * This is intentionally separate from transport and placement failures so a
 * runner can stop before attaching any provider or durable Session resource.
 */
export class SessionCreationCorrespondenceConflictError extends Error {
  readonly code = 'creation_conflict' as const;

  constructor() {
    super('Session creation correspondence conflicts with the existing Session');
    this.name = 'SessionCreationCorrespondenceConflictError';
  }
}

export function isSessionCreationCorrespondenceConflictError(
  error: unknown,
): error is SessionCreationCorrespondenceConflictError {
  return error instanceof SessionCreationCorrespondenceConflictError;
}
