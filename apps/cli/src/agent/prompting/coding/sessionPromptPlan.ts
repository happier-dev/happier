import { AgentSessionStartupInstructionsV1Schema } from '@happier-dev/protocol/runtime/agentSessionStartupInstructionsV1';
import type { AgentSessionStartupInstructionsV1, SessionRolePromptContextV1, CodingPromptBehaviorV1 } from '@happier-dev/protocol';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { HostSessionRuntimeRunOptions } from '@/agent/runtime/session/loop/runHostSessionRuntime';
import type { DaemonAgentRuntimeTurnContributionsBridge } from '@/agent/runtime/session/process/agentRuntimeDaemonTurnContributionsBridge';
import { resolveAgentToolsDelivery } from '@/agent/tools/happierTools/runtime/resolveAgentToolsDelivery';
import { resolveCliFeatureDecision } from '@/features/featureDecisionService';
import { resolvePluginPromptAssetBlocks, resolvePluginToolPromptContributions } from '@/plugins/runtime/hooks/execution/dispatchAgentTurnHooks';
import { resolveEffectiveCodingPromptPlan } from './resolveEffectiveCodingPrompt';

export type SessionPromptPlanResolver = ((args?: Readonly<{
  baseOverride?: string | null;
  excludePluginIds?: readonly string[];
  signal?: AbortSignal;
}>) => Promise<string>) & Readonly<{
  /** Current full-plan identity, retained by this producer across native runtime replacement. */
  readStartupInstructions?: () => AgentSessionStartupInstructionsV1 | null;
  /** Policy from the same current prepared plan, unavailable after a failed preparation. */
  readCodingPromptBehavior?: () => CodingPromptBehaviorV1 | null;
}>;

/** One full-plan producer for native startup and immediately-before-dispatch revisions. */
export function createSessionPromptPlanResolver(params: Readonly<{
  opts: HostSessionRuntimeRunOptions;
  session: Pick<ApiSessionClient, 'sessionId' | 'getMetadataSnapshot'>;
  agentId: string;
  machineId: string;
  directory: string;
  memoryRecallGuidanceEnabled: boolean;
  readNativeSessionId: () => string | null;
  resolveRoleContext?: (signal?: AbortSignal) => Promise<SessionRolePromptContextV1 | null>;
  daemonBridge?: DaemonAgentRuntimeTurnContributionsBridge;
}>): SessionPromptPlanResolver {
  const toolDelivery = resolveAgentToolsDelivery(params.agentId);
  let resolvedText: string | null = null;
  let revision = params.opts.agentSessionStartupInstructionsV1?.revision ?? 1;
  let startupInstructions: AgentSessionStartupInstructionsV1 | null = null;
  let preparedBehavior: Readonly<{ settings: unknown; profileId: string | null; behavior: CodingPromptBehaviorV1 }> | null = null;
  const resolve: SessionPromptPlanResolver = async ({ baseOverride, excludePluginIds, signal = new AbortController().signal } = {}) => {
    preparedBehavior = null;
    // Each preparation observes current document content; dedupe only within this plan.
    const cache = new Map<string, string | null>();
    const executionRunsFeatureEnabled = resolveCliFeatureDecision({
      featureId: 'execution.runs', env: process.env,
    }).state === 'enabled';
    const featureIds = executionRunsFeatureEnabled ? ['execution.runs'] : [];
    const scope = {
      sessionId: params.session.sessionId, machineId: params.machineId,
      featureIds, ...(excludePluginIds ? { excludePluginIds } : {}), signal,
    };
    const promptContributions = params.daemonBridge
      ? await params.daemonBridge.resolvePrompt(scope)
      : {
          promptAssetBlocks: await resolvePluginPromptAssetBlocks({ ...scope, agentId: params.agentId }),
          toolPromptContributions: await resolvePluginToolPromptContributions(
            excludePluginIds ? { excludePluginIds } : undefined,
          ),
        };
    const settings = params.opts.accountSettingsContext?.settings ?? null;
    const profileId = params.session.getMetadataSnapshot()?.profileId ?? null;
    const plan = await resolveEffectiveCodingPromptPlan({
      credentials: params.opts.credentials,
      settings,
      profileId,
      signal,
      baseOverride,
      roleContext: await params.resolveRoleContext?.(signal),
      startupInstructions: params.opts.agentSessionStartupInstructionsV1,
      executionRunsFeatureEnabled,
      agentId: params.agentId,
      toolDelivery,
      toolDeliverySessionId: toolDelivery === 'shell_bridge'
        ? params.session.sessionId : params.readNativeSessionId(),
      toolDeliveryDirectory: params.directory,
      memoryMachineId: params.machineId,
      memoryRecallGuidanceEnabled: params.memoryRecallGuidanceEnabled,
      toolPromptContributions: promptContributions.toolPromptContributions,
      promptAssetBlocks: promptContributions.promptAssetBlocks,
      cache,
    });
    signal.throwIfAborted();
    const text = plan.text.trim().normalize('NFC');
    preparedBehavior = { settings, profileId, behavior: plan.codingPromptBehavior };
    if (text !== resolvedText) {
      if (resolvedText !== null) revision += 1;
      startupInstructions = text ? AgentSessionStartupInstructionsV1Schema.parse({
        v: 1, id: 'happier.coding_session_plan', revision, instructions: text,
      }) : null;
      resolvedText = text;
    }
    return text;
  };
  return Object.assign(resolve, { readStartupInstructions: () => startupInstructions,
    readCodingPromptBehavior: () => preparedBehavior
      && preparedBehavior.settings === (params.opts.accountSettingsContext?.settings ?? null)
      && preparedBehavior.profileId === (params.session.getMetadataSnapshot()?.profileId ?? null)
      ? preparedBehavior.behavior : null });
}
