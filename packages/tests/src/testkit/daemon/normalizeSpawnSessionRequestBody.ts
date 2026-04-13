import { parseBackendTargetKey, type BackendTargetRefV1 } from '@happier-dev/protocol';

type SpawnSessionRequestBody = Readonly<Record<string, unknown>> & Readonly<{
  agent?: unknown;
  backendTarget?: BackendTargetRefV1;
}>;

type NormalizedSpawnSessionRequestBody<T extends SpawnSessionRequestBody> = T & Readonly<{
  agent: string;
  backendTarget: BackendTargetRefV1;
}>;

export function normalizeSpawnSessionRequestBody<T extends SpawnSessionRequestBody>(
  body: T,
): NormalizedSpawnSessionRequestBody<T> {
  const agent = typeof body.agent === 'string' && body.agent.trim().length > 0
    ? body.agent
    : 'claude';

  const backendTarget = body.backendTarget ?? parseBackendTargetKey(`agent:${agent}`);
  return {
    ...body,
    agent,
    backendTarget,
  } as NormalizedSpawnSessionRequestBody<T>;
}
