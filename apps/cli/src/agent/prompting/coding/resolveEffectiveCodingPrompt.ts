import {
  PluginContributionIdentityV1Schema,
  buildCodingSessionPromptPlanBaseV1,
  buildPromptPlanDiagnosticsV1,
  buildPromptPlanV1,
  buildQualifiedPluginContributionKey,
  renderPromptPlanV1,
  resolveCodingPromptBehaviorV1,
  type PromptBlockV1,
  type PromptPlanV1,
} from '@happier-dev/protocol';

import type { StoredCredentials } from '@/persistence';
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
  pluginId?: string | null;
  id: string;
  name?: string | null;
  title?: string | null;
  promptSnippet?: string | null;
  promptGuidelines?: readonly string[] | null;
}>;

type AgentCompositionToolPromptContribution = ToolPromptContribution & Readonly<{
  pluginId: string;
}>;

type AgentCompositionPromptArgs = Readonly<{
  toolPromptContributions: readonly AgentCompositionToolPromptContribution[];
  promptAssetBlocks: readonly PromptBlockV1[];
  additionalInstructions: readonly Readonly<{
    pluginId: string;
    text: string;
  }>[];
}>;

type ResolveEffectiveCodingPromptArgs = Readonly<{
  credentials: StoredCredentials;
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

function resolveToolPromptContributionText(
  contribution: ToolPromptContribution,
): string | null {
  const snippet = typeof contribution.promptSnippet === 'string'
    ? contribution.promptSnippet.trim()
    : '';
  const guidelines = (contribution.promptGuidelines ?? [])
    .map((guideline) => guideline.trim())
    .filter((guideline) => guideline.length > 0);
  if (!snippet && guidelines.length === 0) {
    return null;
  }
  const label = (typeof contribution.title === 'string' && contribution.title.trim())
    || (typeof contribution.name === 'string' && contribution.name.trim())
    || contribution.id;
  return [
    `Tool: ${label}`,
    ...(snippet ? [snippet] : []),
    ...(guidelines.length === 0 ? [] : [
      'Guidelines:',
      ...guidelines.map((guideline) => `- ${guideline}`),
    ]),
  ].join('\n');
}

function resolveToolPromptContributionBlocks(
  contributions: readonly ToolPromptContribution[] | undefined,
): readonly PromptBlockV1[] {
  const blocks: PromptBlockV1[] = [];
  for (const contribution of contributions ?? []) {
    const text = resolveToolPromptContributionText(contribution);
    if (!text) continue;
    blocks.push({
      id: `plugin_tool_prompt.${blocks.length + 1}`,
      scope: 'user_prompt',
      text,
    });
  }
  return Object.freeze(blocks);
}

type AgentCompositionContributionKind = 'prompt_asset' | 'tool' | 'instructions';

function frameAgentCompositionPluginContent(params: Readonly<{
  pluginId: string;
  kind: AgentCompositionContributionKind;
  contributionId?: string;
  text: string;
}>): string {
  const lines = params.text
    .replace(/\r\n?|\u2028|\u2029/gu, '\n')
    .split('\n')
    .map((line) => `| ${line}`);
  return [
    '<<<HAPPIER_PLUGIN_CONTRIBUTION>>>',
    `plugin_id: ${JSON.stringify(params.pluginId)}`,
    `kind: ${JSON.stringify(params.kind)}`,
    ...(params.contributionId === undefined
      ? []
      : [`contribution_id: ${JSON.stringify(params.contributionId)}`]),
    'content:',
    ...lines,
    '<<<END_HAPPIER_PLUGIN_CONTRIBUTION>>>',
  ].join('\n');
}

function readAgentCompositionPromptAssetIdentity(
  block: PromptBlockV1,
): Readonly<{ pluginId: string; localId: string }> | null {
  const prefix = 'plugin_prompt_asset.';
  if (!block.id.startsWith(prefix)) return null;
  const separatorIndex = block.id.indexOf('/', prefix.length);
  if (separatorIndex <= prefix.length || separatorIndex === block.id.length - 1) return null;
  const parsed = PluginContributionIdentityV1Schema.safeParse({
    pluginId: block.id.slice(prefix.length, separatorIndex),
    localId: block.id.slice(separatorIndex + 1),
  });
  if (!parsed.success) return null;
  return buildQualifiedPluginContributionKey(parsed.data) === block.id.slice(prefix.length)
    ? parsed.data
    : null;
}

function resolveAgentCompositionPromptAssetBlocks(
  blocks: readonly PromptBlockV1[],
): readonly PromptBlockV1[] {
  return Object.freeze(blocks.flatMap((block, index) => {
    const identity = readAgentCompositionPromptAssetIdentity(block);
    if (!identity) return [];
    return [{
      id: `agent_composition.prompt_asset.${index + 1}`,
      scope: block.scope,
      ...(block.enabled === undefined ? {} : { enabled: block.enabled }),
      text: frameAgentCompositionPluginContent({
        pluginId: identity.pluginId,
        kind: 'prompt_asset',
        contributionId: identity.localId,
        text: block.text,
      }),
    } satisfies PromptBlockV1];
  }));
}

function resolveAgentCompositionToolPromptBlocks(
  contributions: readonly AgentCompositionToolPromptContribution[],
): readonly PromptBlockV1[] {
  const blocks: PromptBlockV1[] = [];
  for (const contribution of contributions) {
    const text = resolveToolPromptContributionText(contribution);
    if (!text) continue;
    blocks.push({
      id: `agent_composition.tool.${blocks.length + 1}`,
      scope: 'user_prompt',
      text: frameAgentCompositionPluginContent({
        pluginId: contribution.pluginId,
        kind: 'tool',
        contributionId: contribution.id,
        text,
      }),
    });
  }
  return Object.freeze(blocks);
}

/**
 * Renders only the accepted next-turn augmentation through the canonical
 * coding prompt-plan owner. The caller appends this bounded text at the
 * provider dispatch boundary; it never replaces the session base prompt.
 */
export function resolveAgentCompositionPromptText(
  args: AgentCompositionPromptArgs,
): string {
  const instructionBlocks = args.additionalInstructions.map((instruction, index) => ({
    id: `agent_composition.instruction.${index + 1}`,
    scope: 'turn' as const,
    text: frameAgentCompositionPluginContent({
      pluginId: instruction.pluginId,
      kind: 'instructions',
      text: instruction.text,
    }),
  }));
  return renderPromptPlanV1(buildPromptPlanV1({
    modality: 'coding',
    blocks: [
      ...resolveAgentCompositionPromptAssetBlocks(args.promptAssetBlocks),
      ...resolveAgentCompositionToolPromptBlocks(args.toolPromptContributions),
      ...instructionBlocks,
    ],
  }));
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
