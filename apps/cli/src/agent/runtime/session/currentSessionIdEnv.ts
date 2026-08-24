import { readNonBlankOpaqueIdentifier } from '@/utils/opaqueIdentifiers';

export const HAPPIER_SESSION_ID_ENV_KEY = 'HAPPIER_SESSION_ID' as const;

export function readCurrentHappierSessionIdFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  return readNonBlankOpaqueIdentifier(env[HAPPIER_SESSION_ID_ENV_KEY]);
}

export function withCurrentHappierSessionId(
  env: NodeJS.ProcessEnv,
  sessionId: string,
): NodeJS.ProcessEnv {
  const resolvedSessionId = readNonBlankOpaqueIdentifier(sessionId);
  const nextEnv: NodeJS.ProcessEnv = { ...env };
  if (resolvedSessionId && !resolvedSessionId.startsWith('offline-')) {
    nextEnv[HAPPIER_SESSION_ID_ENV_KEY] = resolvedSessionId;
  } else {
    delete nextEnv[HAPPIER_SESSION_ID_ENV_KEY];
  }
  return nextEnv;
}
