import {
  buildCodingSessionPromptPlanBaseV1,
  buildPromptPlanDiagnosticsV1,
  buildPromptPlanV1,
  renderPromptPlanV1,
  resolveCodingPromptBehaviorV1,
  type PromptBlockV1,
  type PromptPlanV1,
} from '@happier-dev/protocol';

import type { Credentials } from '@/persistence';
import { resolveCliMemoryRecallGuidanceEnabled } from '@/agent/prompts/library/resolveCliMemoryRecallGuidanceEnabled';
import {
  resolveCliPromptStackSystemAppendBlocks,
  type PromptArtifactRecord,
} from '@/agent/prompts/library/resolveCliPromptStackSystemAppendBlocks';
import { resolveCodingProviderBehaviorBlocks } from './providerPromptBehaviorRegistry';
import { resolveCodingToolDeliveryBlocks } from './toolDeliveryPromptRegistry';

type FetchPromptArtifactRecord = (artifactId: string) => Promise<PromptArtifactRecord | null>;
export type { PromptArtifactRecord };

type ToolPromptContribution = Readonly<{
  id: string;
  name?: string | null;
  title?: string | null;
  promptSnippet?: string | null;
  promptGuidelines?: readonly string[] | null;
}>;

type ResolveEffectiveCodingPromptArgs = Readonly<{
  credentials: Credentials;
  settings: Record<string, unknown> | null | undefined;
  profileId: string | null | undefined;
  baseOverride?: string | null;
  executionRunsFeatureEnabled?: boolean;
  memoryRecallGuidanceEnabled?: boolean;
  agentId?: string | null | undefined;
  disableTodos?: boolean;
  toolDelivery?: 'native_mcp' | 'shell_bridge' | 'unsupported';
  toolDeliverySessionId?: string | null;
  toolDeliveryDirectory?: string | null;
  memoryMachineId?: string | null;
  toolPromptContributions?: readonly ToolPromptContribution[];
  /**
   * Already-qualified, policy-approved, generation-bound prompt asset blocks.
   * Resolution stays at the prompt-asset/SVC11 seam; this owner only composes
   * them into the canonical coding prompt plan.
   */
  promptAssetBlocks?: readonly PromptBlockV1[];
  cache?: Map<string, string | null>;
  fetchPromptArtifactRecord?: FetchPromptArtifactRecord;
}>;

function resolveBasePromptSettingsForToolDelivery(params: Readonly<{
  settings: Record<string, unknown>;
  toolDelivery: NonNullable<ResolveEffectiveCodingPromptArgs['toolDelivery']>;
}>): Record<string, unknown> {
  if (params.toolDelivery === 'native_mcp') return params.settings;
  const promptBehavior = resolveCodingPromptBehaviorV1(params.settings);
  return {
    ...params.settings,
    codingPromptBehaviorV1: {
      ...promptBehavior,
      sessionTitleUpdates: 'disabled',
    },
  };
}

function resolveToolPromptContributionBlocks(
  contributions: readonly ToolPromptContribution[] | undefined,
): readonly PromptBlockV1[] {
  const blocks: PromptBlockV1[] = [];
  for (const contribution of contributions ?? []) {
    const snippet = typeof contribution.promptSnippet === 'string'
      ? contribution.promptSnippet.trim()
      : '';
    const guidelines = (contribution.promptGuidelines ?? [])
      .map((guideline) => guideline.trim())
      .filter((guideline) => guideline.length > 0);
    if (!snippet && guidelines.length === 0) {
      continue;
    }
    const label = (typeof contribution.title === 'string' && contribution.title.trim())
      || (typeof contribution.name === 'string' && contribution.name.trim())
      || contribution.id;
    const parts = [
      `Tool: ${label}`,
      ...(snippet ? [snippet] : []),
      ...(guidelines.length === 0 ? [] : [
        'Guidelines:',
        ...guidelines.map((guideline) => `- ${guideline}`),
      ]),
    ];
    blocks.push({
      id: `plugin_tool_prompt.${blocks.length + 1}`,
      scope: 'user_prompt',
      text: parts.join('\n'),
    });
  }
  return Object.freeze(blocks);
}

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
  const toolDelivery = args.toolDelivery ?? 'native_mcp';
  const basePromptSettings = resolveBasePromptSettingsForToolDelivery({
    settings,
    toolDelivery,
  });
  const cache = args.cache ?? new Map<string, string | null>();
  const memoryRecallGuidanceEnabled =
    typeof args.memoryRecallGuidanceEnabled === 'boolean'
      ? args.memoryRecallGuidanceEnabled
      : await resolveCliMemoryRecallGuidanceEnabled();

  const basePlan = buildCodingSessionPromptPlanBaseV1({
    settings: basePromptSettings,
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
    agentId: args.agentId,
    disableTodos: args.disableTodos,
  });
  const toolPromptBlocks = resolveToolPromptContributionBlocks(args.toolPromptContributions);
  const toolDeliveryBlocks = (() => {
    const sessionId = typeof args.toolDeliverySessionId === 'string' ? args.toolDeliverySessionId.trim() : '';
    const directory = typeof args.toolDeliveryDirectory === 'string' ? args.toolDeliveryDirectory.trim() : '';
    if (toolDelivery !== 'shell_bridge' || !sessionId || !directory) return [] satisfies PromptBlockV1[];
    return resolveCodingToolDeliveryBlocks({
      delivery: toolDelivery,
      sessionId,
      directory,
      settings,
      memoryRecallGuidance: {
        enabled: memoryRecallGuidanceEnabled,
        machineId: args.memoryMachineId ?? null,
      },
    });
  })();
  const plan = buildPromptPlanV1({
    modality: 'coding',
    blocks: [
      ...basePlan.blocks,
      ...promptStackBlocks,
      ...providerBehaviorBlocks,
      ...(args.promptAssetBlocks ?? []),
      ...toolPromptBlocks,
      ...toolDeliveryBlocks,
    ],
  });

  return {
    plan,
    text: renderPromptPlanV1(plan),
    diagnostics: buildPromptPlanDiagnosticsV1(plan),
  };
}
