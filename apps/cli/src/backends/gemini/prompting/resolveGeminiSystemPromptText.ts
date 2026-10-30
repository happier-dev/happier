import type { Credentials } from '@/persistence';
import { getAgentToolsCapability } from '@happier-dev/agents';
import { resolveEffectiveCodingPromptText } from '@/agent/prompting/coding/resolveEffectiveCodingPrompt';

export async function resolveGeminiSystemPromptText(params: Readonly<{
  credentials: Credentials;
  settings: Record<string, unknown> | null | undefined;
  profileId: string | null | undefined;
  sessionMetadata?: unknown;
  baseOverride?: string | null;
  executionRunsFeatureEnabled?: boolean;
  sessionId: string;
  runtimeDirectory: string;
  machineId: string | null;
  cache?: Map<string, string | null>;
}>): Promise<string> {
  return await resolveEffectiveCodingPromptText({
    credentials: params.credentials,
    settings: params.settings,
    profileId: params.profileId,
    sessionMetadata: params.sessionMetadata,
    baseOverride: params.baseOverride,
    executionRunsFeatureEnabled: params.executionRunsFeatureEnabled,
    providerId: 'gemini',
    toolDelivery: getAgentToolsCapability('gemini').delivery,
    toolDeliverySessionId: params.sessionId,
    toolDeliveryDirectory: params.runtimeDirectory,
    memoryMachineId: params.machineId,
    cache: params.cache,
  });
}
