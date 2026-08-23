import type { Credentials } from '@/persistence';
import type { DirectSpawnedSessionTransport } from '@/session/services/createSpawnedSession';
import type { ActionExecutorDeps } from '@happier-dev/protocol';
import { resolveSessionEncryptionContextFromCredentials } from '@/session/transport/encryption/sessionEncryptionContext';

import { createCliActionExecutor } from './createCliActionExecutor';

export function createCliActionExecutorFromCredentials(params: Readonly<{
  credentials: Credentials;
  directSpawnTransport?: DirectSpawnedSessionTransport;
  overrides?: Partial<ActionExecutorDeps>;
}>): ReturnType<typeof createCliActionExecutor> {
  const ctx = resolveSessionEncryptionContextFromCredentials(params.credentials);

  return createCliActionExecutor({
    token: params.credentials.token,
    credentials: params.credentials,
    sessionId: 'cli-global',
    ctx,
    ...(params.directSpawnTransport ? { directSpawnTransport: params.directSpawnTransport } : {}),
  }, params.overrides);
}
