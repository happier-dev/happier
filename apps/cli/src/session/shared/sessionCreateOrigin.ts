import { SessionCreateOriginFieldsV1Schema } from '@happier-dev/protocol/sessions/creation/sessionCreateOriginV1';
import type { SessionCreateOriginFieldsV1 } from '@happier-dev/protocol';

export const HAPPIER_SESSION_CREATE_ORIGIN_ENV_KEY = 'HAPPIER_SESSION_CREATE_ORIGIN_V1_JSON';

/** Only the authenticated host's typed create facts cross this transport. */
export function pickSessionCreateOriginFields(input: SessionCreateOriginFieldsV1): SessionCreateOriginFieldsV1 {
  return SessionCreateOriginFieldsV1Schema.parse({
    ...(input.originKind !== undefined ? { originKind: input.originKind } : {}),
    ...(input.originSessionId !== undefined ? { originSessionId: input.originSessionId } : {}),
    ...(input.originRunId !== undefined ? { originRunId: input.originRunId } : {}),
    ...(input.workDepth !== undefined ? { workDepth: input.workDepth } : {}),
  });
}

/** A malformed host carrier fails before create; it never becomes originless. */
export function readSessionCreateOriginFromEnv(env: NodeJS.ProcessEnv = process.env): SessionCreateOriginFieldsV1 {
  const raw = env[HAPPIER_SESSION_CREATE_ORIGIN_ENV_KEY];
  return raw === undefined ? {} : SessionCreateOriginFieldsV1Schema.parse(JSON.parse(raw));
}
