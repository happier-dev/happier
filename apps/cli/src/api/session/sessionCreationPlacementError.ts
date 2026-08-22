/**
 * Exact, server-authored creation-time organization-placement refusal.
 *
 * This intentionally does not classify generic HTTP, availability, or
 * transport failures. Those retain their existing API semantics until their
 * owning boundary produces a stable code of its own.
 */
export class SessionCreationPlacementError extends Error {
  readonly code = 'organization_invalid' as const;

  constructor() {
    super('Session creation organization placement is invalid');
    this.name = 'SessionCreationPlacementError';
  }
}

export function isSessionCreationPlacementError(
  error: unknown,
): error is SessionCreationPlacementError {
  return error instanceof SessionCreationPlacementError;
}
