import { buildInactiveSessionResumeSpawnOptions } from './buildInactiveSessionResumeSpawnOptions';

export type BuildInactiveUsageLimitResumeSpawnOptionsParams = Readonly<{
  fallbackMachineId: string;
  sessionId: string;
  rawSession: unknown;
  metadata: Record<string, unknown>;
}>;

export function buildInactiveUsageLimitResumeSpawnOptions(
  params: BuildInactiveUsageLimitResumeSpawnOptionsParams,
): ReturnType<typeof buildInactiveSessionResumeSpawnOptions> {
  return buildInactiveSessionResumeSpawnOptions(params);
}
