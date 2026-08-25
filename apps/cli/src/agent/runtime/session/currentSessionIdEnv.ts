import { readNonBlankOpaqueIdentifier } from '@/utils/opaqueIdentifiers';

export const HAPPIER_SESSION_ID_ENV_KEY = 'HAPPIER_SESSION_ID' as const;

export function normalizeCurrentHappierSessionId(value: unknown): string | null {
  const sessionId = readNonBlankOpaqueIdentifier(value);
  return sessionId && !sessionId.startsWith('offline-') ? sessionId : null;
}

export function readCurrentHappierSessionIdFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  return normalizeCurrentHappierSessionId(env[HAPPIER_SESSION_ID_ENV_KEY]);
}

export function withCurrentHappierSessionId(
  env: NodeJS.ProcessEnv,
  sessionId: string,
): NodeJS.ProcessEnv {
  const resolvedSessionId = normalizeCurrentHappierSessionId(sessionId);
  const nextEnv: NodeJS.ProcessEnv = { ...env };
  if (resolvedSessionId) {
    nextEnv[HAPPIER_SESSION_ID_ENV_KEY] = resolvedSessionId;
  } else {
    delete nextEnv[HAPPIER_SESSION_ID_ENV_KEY];
  }
  return nextEnv;
}
