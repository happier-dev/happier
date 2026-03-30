import type { Credentials } from '@/persistence';
import { resolveEffectiveCodingPromptText } from '@/agent/prompting/coding/resolveEffectiveCodingPrompt';

export async function resolveGeminiSystemPromptText(params: Readonly<{
  credentials: Credentials;
  settings: Record<string, unknown> | null | undefined;
  profileId: string | null | undefined;
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
    baseOverride: params.baseOverride,
    executionRunsFeatureEnabled: params.executionRunsFeatureEnabled,
    providerId: 'gemini',
    toolDelivery: 'shell_bridge',
    toolDeliverySessionId: params.sessionId,
    toolDeliveryDirectory: params.runtimeDirectory,
    memoryMachineId: params.machineId,
    cache: params.cache,
  });
}
