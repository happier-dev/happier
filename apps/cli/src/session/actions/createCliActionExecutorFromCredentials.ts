import type { Credentials } from '@/persistence';
import { resolveSessionEncryptionContextFromCredentials } from '@/session/transport/encryption/sessionEncryptionContext';

import { createCliActionExecutor } from './createCliActionExecutor';

export function createCliActionExecutorFromCredentials(params: Readonly<{ credentials: Credentials }>): ReturnType<typeof createCliActionExecutor> {
  const ctx = resolveSessionEncryptionContextFromCredentials(params.credentials);

  return createCliActionExecutor({
    token: params.credentials.token,
    credentials: params.credentials,
    sessionId: 'cli-global',
    ctx,
  });
}
