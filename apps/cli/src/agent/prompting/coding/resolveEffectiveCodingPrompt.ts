import { PluginContributionIdentityV1Schema } from '@happier-dev/protocol/plugins/contribution-identity';
import { buildCodingSessionPromptPlanBaseV1 } from '@happier-dev/protocol/prompts/buildAppendSystemPromptBaseV1';
import { buildPromptPlanDiagnosticsV1 } from '@happier-dev/protocol/prompts/promptPlanV1';
import { buildPromptPlanV1, renderPromptPlanV1 } from '@happier-dev/protocol/prompts/promptPlanV1';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { renderSessionRoleBlockV1 } from '@happier-dev/protocol/prompts/roles/renderSessionRoleBlockV1';
import { resolveEffectiveCodingPromptBehaviorV1 } from '@happier-dev/protocol/prompts/effectiveCodingPromptBehaviorV1';
import type { CodingPromptBehaviorV1, PromptBlockV1, PromptPlanV1, SessionRolePromptContextV1, AgentSessionStartupInstructionsV1 } from '@happier-dev/protocol';

import type { StoredCredentials } from '@/persistence';
import type { ProfileCatalogSnapshotV1 } from '@happier-dev/protocol/profiles/profileCatalogV1';
import type { AiLaunchProfile } from '@happier-dev/protocol/profiles/read';
import type { PromptStackAdmittedEntryV1 } from '@happier-dev/protocol/prompts/library/resolvePromptStackSystemAppendBlocksV1';
import { resolveCliMemoryRecallGuidanceEnabled } from '@/agent/prompts/library/resolveCliMemoryRecallGuidanceEnabled';
import {
  resolveCliPromptStackSystemAppendBlocks,
  type CliPromptStackSystemAppendInput,
} from '@/agent/prompts/library/resolveCliPromptStackSystemAppendBlocks';
import { resolveCodingProviderBehaviorBlocks } from './providerPromptBehaviorRegistry';
import { resolveCodingToolDeliveryBlocks } from './toolDeliveryPromptRegistry';
import { loadAccountLaunchProfileArtifacts, readProfileCollectionFromAccountSnapshot, readProfileSettingsForAccount } from '@/settings/profiles/readProfilesFromAccountSettings';
import { isSessionAgentChangeTitleToolAvailable } from '@/agent/tools/happierTools/resolveSessionNativeToolBridge';
import { createPromptCompositionScope, measurePromptPlanComposition, type PromptCompositionScope, type PromptPlanComposition } from '../promptComposition';

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

export type ResolveEffectiveCodingPromptArgs = Omit<CliPromptStackSystemAppendInput, 'surface' | 'settings' | 'profileId'> & Readonly<{
  credentials?: StoredCredentials;
  settings: Record<string, unknown> | null | undefined;
  profileId: string | null | undefined;
  profileCatalog?: ProfileCatalogSnapshotV1;
  /** Already admitted Profile; null is authoritative absence. */
  currentProfile?: AiLaunchProfile | null;
  baseOverride?: string | null;
  roleContext?: SessionRolePromptContextV1 | null;
  startupInstructions?: AgentSessionStartupInstructionsV1;
  executionRunsFeatureEnabled?: boolean;
  memoryRecallGuidanceEnabled?: boolean;
  agentId?: string | null | undefined;
  disableTodos?: boolean;
  toolDelivery?: 'native_mcp' | 'native_extension' | 'shell_bridge' | 'unsupported';
  toolDeliverySessionId?: string | null;
  toolDeliveryDirectory?: string | null;
  memoryMachineId?: string | null;
  sessionTitleToolAvailable?: boolean;
  createdAsBot?: boolean;
  toolPromptContributions?: readonly ToolPromptContribution[];
  /**
   * Already-qualified, policy-approved, generation-bound prompt asset blocks.
   * Resolution stays at the prompt-asset/SVC11 seam; this owner only composes
   * them into the canonical coding prompt plan.
   */
  promptAssetBlocks?: readonly PromptBlockV1[];
  signal?: AbortSignal;
  compositionScope?: PromptCompositionScope;
}>;

/**
 * The hard runtime/capability constraint, applied last and on top of the
 * already-resolved Account+profile behavior. A profile expresses a preference;
 * it can never re-enable base-plan title guidance the delivery mode cannot
 * carry. Under a shell bridge the guidance is not lost — it moves to the tool
 * appendix, which is composed from the unconstrained resolved behavior.
 */
function applyToolDeliveryConstraintToPromptSettings(params: Readonly<{
  promptSettings: Record<string, unknown>;
  behavior: CodingPromptBehaviorV1;
  toolDelivery: NonNullable<ResolveEffectiveCodingPromptArgs['toolDelivery']>;
}>): Record<string, unknown> {
  if (params.toolDelivery === 'native_mcp' || params.toolDelivery === 'native_extension') {
    return params.promptSettings;
  }
  return {
    ...params.promptSettings,
    codingPromptBehaviorV1: {
      ...params.behavior,
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
  codingPromptBehavior: CodingPromptBehaviorV1;
  admittedEntries: readonly PromptStackAdmittedEntryV1[];
  composition: PromptPlanComposition;
}>> {
  const settings = args.settings && typeof args.settings === 'object' && !Array.isArray(args.settings)
    ? args.settings
    : {};
  const toolDelivery = args.toolDelivery ?? 'native_mcp';
  // Account default, then the selected Launch Profile's sparse override —
  // resolved exactly once here, for the whole prompt. Both the base plan and
  // the tool-delivery appendix are composed from this one fact, so a profile
  // can never be honored on one and silently ignored on the other.
  const profileId = args.profileId?.trim() ?? '';
  const profileCatalog = args.profileCatalog ?? (args.currentProfile === undefined && args.credentials && profileId
    ? await (await import('@/settings/profiles/hydrateProfileCatalog')).refreshActiveProfileCatalog({ credentials: args.credentials, signal: args.signal })
    : undefined);
  const profileSettings = args.credentials && profileCatalog
    ? readProfileSettingsForAccount({ settings, credentials: args.credentials, profileCatalog }) : settings;
  const artifactsById = args.currentProfile === undefined && args.credentials && profileId
    ? await loadAccountLaunchProfileArtifacts(profileSettings, args.credentials, args.signal, profileCatalog) : undefined;
  const selectedProfiles = args.currentProfile === undefined && profileId ? readProfileCollectionFromAccountSnapshot(profileSettings, artifactsById, profileCatalog).entries
    .filter((entry) => entry.kind !== 'opaque' && entry.profile.id === profileId) : [];
  const selectedEntry = selectedProfiles.length === 1 ? selectedProfiles[0] : null;
  const selectedProfile = args.currentProfile !== undefined ? args.currentProfile
    : selectedEntry && selectedEntry.kind !== 'opaque' ? selectedEntry.profile : null;
  if (selectedProfile?.enabled === false) throw Object.assign(new Error('The selected Profile is disabled'), { code: 'profile_disabled' });
  args.signal?.throwIfAborted();
  const codingPromptBehavior = resolveEffectiveCodingPromptBehaviorV1({
    settings,
    profileId: args.profileId,
    selectedProfile,
  });
  const promptSettings: Record<string, unknown> = {
    ...settings,
    codingPromptBehaviorV1: codingPromptBehavior,
  };
  const basePromptSettings = applyToolDeliveryConstraintToPromptSettings({
    promptSettings,
    behavior: codingPromptBehavior,
    toolDelivery,
  });
  const memoryRecallGuidanceEnabled = args.memoryEnabled !== false && (
    typeof args.memoryRecallGuidanceEnabled === 'boolean'
      ? args.memoryRecallGuidanceEnabled
      : await resolveCliMemoryRecallGuidanceEnabled());

  const sessionTitleToolAvailable = args.sessionTitleToolAvailable ?? isSessionAgentChangeTitleToolAvailable({
    accountSettings: settings, codingPromptBehavior,
  });
  const basePlan = buildCodingSessionPromptPlanBaseV1({
    settings: basePromptSettings,
    base: args.baseOverride === null ? '' : args.baseOverride,
    executionRunsFeatureEnabled: args.executionRunsFeatureEnabled === true,
    memoryRecallGuidanceEnabled,
    sessionTitleToolAvailable,
    createdAsBot: args.createdAsBot,
  });
  const stackResult = await resolveCliPromptStackSystemAppendBlocks({
    ...args,
    surface: 'coding',
    credentials: args.credentials,
    settings,
    profileId: args.profileId,
    profileEntries: args.profileEntries ?? selectedProfile?.promptStack ?? [],
  });

  const promptStackBlocks: PromptBlockV1[] = stackResult.blocks.map((text, index) => ({
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
      settings: promptSettings,
      sessionTitleToolAvailable,
      createdAsBot: args.createdAsBot,
      memoryRecallGuidance: {
        enabled: memoryRecallGuidanceEnabled,
        machineId: args.memoryMachineId ?? null,
      },
    });
  })();
  const roleInstructions = args.roleContext ? renderSessionRoleBlockV1(args.roleContext) : '';
  const plan = buildPromptPlanV1({
    modality: 'coding',
    blocks: [
      ...basePlan.blocks,
      ...promptStackBlocks,
      ...(roleInstructions
        ? [{ id: 'session.role_instructions', scope: 'session' as const,
            text: roleInstructions }] : []),
      ...(args.startupInstructions
        ? [{ id: 'caller.startup_instructions', scope: 'session' as const,
            text: args.startupInstructions.instructions }] : []),
      ...providerBehaviorBlocks,
      ...(args.promptAssetBlocks ?? []),
      ...toolPromptBlocks,
      ...toolDeliveryBlocks,
    ],
  });

  return {
    plan,
    composition: measurePromptPlanComposition(plan, args.compositionScope ?? createPromptCompositionScope()),
    codingPromptBehavior,
    admittedEntries: stackResult.admittedEntries,
    text: renderPromptPlanV1(plan),
    diagnostics: buildPromptPlanDiagnosticsV1(plan),
  };
}
