import {
  readBackendTargetRefV2,
  type BackendTargetRefV2,
  type BackendTargetRefV2Input,
} from '@happier-dev/protocol';

type SpawnSessionRequestBody = Readonly<Record<string, unknown>> & Readonly<{
  agent?: unknown;
  backendTarget?: BackendTargetRefV2Input;
}>;

type NormalizedSpawnSessionRequestBody<T extends SpawnSessionRequestBody> = Omit<T, 'agent' | 'backendTarget'> & Readonly<{
  agent: string;
  backendTarget: BackendTargetRefV2;
}>;

export function normalizeSpawnSessionRequestBody<T extends SpawnSessionRequestBody>(
  body: T,
): NormalizedSpawnSessionRequestBody<T> {
  const agent = typeof body.agent === 'string' && body.agent.trim().length > 0
    ? body.agent
    : 'claude';

  const backendTarget = body.backendTarget !== undefined
    ? readBackendTargetRefV2(body.backendTarget)
    : readBackendTargetRefV2(`agent:${agent}`);

  return {
    ...body,
    agent,
    backendTarget,
  } as NormalizedSpawnSessionRequestBody<T>;
}
