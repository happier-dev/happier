import type { ManagedConnectionState } from '@happier-dev/connection-supervisor';

import { createHttpStatusError } from '@/api/client/httpStatusError';

export function assertManagedConnectionReadyForRequest(
  state: ManagedConnectionState,
  opts?: Readonly<{
    requireAuth?: boolean;
    requireOnline?: boolean;
  }>,
): void {
  const requireAuth = opts?.requireAuth !== false;
  const requireOnline = opts?.requireOnline !== false;

  if (state.phase === 'auth_failed') {
    if (requireAuth) {
      throw createHttpStatusError(401, 'Authentication required', 'not_authenticated');
    }
    return;
  }

  if (requireOnline && state.phase !== 'online') {
    throw createHttpStatusError(503, 'Server is currently unreachable');
  }
}
