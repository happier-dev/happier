import {
  buildCodingSessionPromptPlanBaseV1,
  buildPromptPlanDiagnosticsV1,
  buildPromptPlanV1,
  renderPromptPlanV1,
  type PromptBlockV1,
  type PromptPlanV1,
} from '@happier-dev/protocol';

import type { Credentials } from '@/persistence';
import { resolveCliMemoryRecallGuidanceEnabled } from '@/agent/promptLibrary/resolveCliMemoryRecallGuidanceEnabled';
import {
  resolveCliPromptStackSystemAppendBlocks,
  type PromptArtifactRecord,
} from '@/agent/promptLibrary/resolveCliPromptStackSystemAppendBlocks';
import { resolveCodingProviderBehaviorBlocks } from './providerPromptBehaviorRegistry';
import { resolveCodingToolDeliveryBlocks } from './toolDeliveryPromptRegistry';

type FetchPromptArtifactRecord = (artifactId: string) => Promise<PromptArtifactRecord | null>;
export type { PromptArtifactRecord };

type ResolveEffectiveCodingPromptArgs = Readonly<{
  credentials: Credentials;
  settings: Record<string, unknown> | null | undefined;
  profileId: string | null | undefined;
  baseOverride?: string | null;
  executionRunsFeatureEnabled?: boolean;
  memoryRecallGuidanceEnabled?: boolean;
  providerId?: string | null | undefined;
  disableTodos?: boolean;
  toolDelivery?: 'native_mcp' | 'shell_bridge' | 'unsupported';
  toolDeliverySessionId?: string | null;
  toolDeliveryDirectory?: string | null;
  memoryMachineId?: string | null;
  cache?: Map<string, string | null>;
  fetchPromptArtifactRecord?: FetchPromptArtifactRecord;
}>;

export async function resolveEffectiveCodingPromptText(
  args: ResolveEffectiveCodingPromptArgs,
): Promise<string> {
  const resolved = await resolveEffectiveCodingPromptPlan(args);
  return resolved.text;
}

export async function resolveEffectiveCodingPromptPlan(
  args: ResolveEffectiveCodingPromptArgs,
): Promise<Readonly<{
  plan: PromptPlanV1;
  text: string;
  diagnostics: ReturnType<typeof buildPromptPlanDiagnosticsV1>;
}>> {
  const settings = args.settings && typeof args.settings === 'object' && !Array.isArray(args.settings)
    ? args.settings
    : {};
  const cache = args.cache ?? new Map<string, string | null>();
  const memoryRecallGuidanceEnabled =
    typeof args.memoryRecallGuidanceEnabled === 'boolean'
      ? args.memoryRecallGuidanceEnabled
      : await resolveCliMemoryRecallGuidanceEnabled();

  const basePlan = buildCodingSessionPromptPlanBaseV1({
    settings,
    base: args.baseOverride === null ? '' : args.baseOverride,
    executionRunsFeatureEnabled: args.executionRunsFeatureEnabled === true,
    memoryRecallGuidanceEnabled,
  });
  const stackBlocks = await resolveCliPromptStackSystemAppendBlocks({
    surface: 'coding',
    credentials: args.credentials,
    settings,
    profileId: args.profileId,
    cache,
    fetchPromptArtifactRecord: args.fetchPromptArtifactRecord,
  });

  const promptStackBlocks: PromptBlockV1[] = stackBlocks.map((text, index) => ({
    id: `prompt_stack.${index + 1}`,
    scope: 'user_prompt',
    text,
  }));
  const providerBehaviorBlocks = resolveCodingProviderBehaviorBlocks({
    providerId: args.providerId,
    disableTodos: args.disableTodos,
  });
  const toolDeliveryBlocks = (() => {
    const toolDelivery = args.toolDelivery ?? 'native_mcp';
    const sessionId = typeof args.toolDeliverySessionId === 'string' ? args.toolDeliverySessionId.trim() : '';
    const directory = typeof args.toolDeliveryDirectory === 'string' ? args.toolDeliveryDirectory.trim() : '';
    if (toolDelivery !== 'shell_bridge' || !sessionId || !directory) return [] satisfies PromptBlockV1[];
    return resolveCodingToolDeliveryBlocks({
      delivery: toolDelivery,
      sessionId,
      directory,
      memoryRecallGuidance: {
        enabled: memoryRecallGuidanceEnabled,
        machineId: args.memoryMachineId ?? null,
      },
    });
  })();
  const plan = buildPromptPlanV1({
    modality: 'coding',
    blocks: [...basePlan.blocks, ...promptStackBlocks, ...providerBehaviorBlocks, ...toolDeliveryBlocks],
  });

  return {
    plan,
    text: renderPromptPlanV1(plan),
    diagnostics: buildPromptPlanDiagnosticsV1(plan),
  };
}
