import { AgentSessionStartupInstructionsV1Schema } from '@happier-dev/protocol/runtime/agentSessionStartupInstructionsV1';
import type { AgentSessionStartupInstructionsV1, SessionRolePromptContextV1, CodingPromptBehaviorV1 } from '@happier-dev/protocol';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { HostSessionRuntimeRunOptions } from '@/agent/runtime/session/loop/runHostSessionRuntime';
import type { DaemonAgentRuntimeTurnContributionsBridge } from '@/agent/runtime/session/process/agentRuntimeDaemonTurnContributionsBridge';
import { resolveAgentToolsDelivery } from '@/agent/tools/happierTools/runtime/resolveAgentToolsDelivery';
import { resolveCliFeatureDecision } from '@/features/featureDecisionService';
import { resolvePluginPromptAssetBlocks, resolvePluginToolPromptContributions } from '@/plugins/runtime/hooks/execution/dispatchAgentTurnHooks';
import { resolveEffectiveCodingPromptPlan } from './resolveEffectiveCodingPrompt';
import { prepareSessionPromptStackInputs } from './sessionPromptStack';
import { getActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshotLifetimeToken, isActiveAccountSettingsSnapshotLifetimeCurrent } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import type { PromptStackAdmittedEntryV1 } from '@happier-dev/protocol/prompts/library/resolvePromptStackSystemAppendBlocksV1';
import { createPromptCompositionScope, type PromptPlanComposition } from '../promptComposition';

type SessionPromptPlanResolveArgs = Readonly<{
  baseOverride?: string | null;
  excludePluginIds?: readonly string[];
  signal?: AbortSignal;
}>;
export type SessionPromptPlanWithAdmittedInventory = Readonly<{
  text: string;
  admittedEntries: readonly PromptStackAdmittedEntryV1[];
}>;
export type SessionPromptPlanResolver = {
  (args: SessionPromptPlanResolveArgs & Readonly<{ includeAdmittedInventory: true }>): Promise<SessionPromptPlanWithAdmittedInventory>;
  (args?: SessionPromptPlanResolveArgs): Promise<string>;
} & Readonly<{
  /** Current full-plan identity, retained by this producer across native runtime replacement. */
  readStartupInstructions?: () => AgentSessionStartupInstructionsV1 | null;
  /** Policy from the same current prepared plan, unavailable after a failed preparation. */
  readCodingPromptBehavior?: () => CodingPromptBehaviorV1 | null;
  readComposition?: () => PromptPlanComposition | null;
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
  const compositionScope = createPromptCompositionScope();
  let composition: PromptPlanComposition | null = null;
  let preparedBehavior: Readonly<{ accountSnapshot: ReturnType<typeof getActiveAccountSettingsSnapshot>; settings: unknown;
    profileId: string | null; behavior: CodingPromptBehaviorV1 }> | null = null;
  const accountScopeKey = params.opts.accountSettingsContext?.scopeKey;
  const accountLifetimeToken = getActiveAccountSettingsSnapshotLifetimeToken();
  const accountContext = {
    scopeKey: accountScopeKey ?? null, lifetimeToken: accountLifetimeToken,
  };
  async function resolve(args: SessionPromptPlanResolveArgs & Readonly<{ includeAdmittedInventory: true }>): Promise<SessionPromptPlanWithAdmittedInventory>;
  async function resolve(args?: SessionPromptPlanResolveArgs): Promise<string>;
  async function resolve({ baseOverride, excludePluginIds, includeAdmittedInventory, signal = new AbortController().signal }:
    SessionPromptPlanResolveArgs & Readonly<{ includeAdmittedInventory?: boolean }> = {}): Promise<string | SessionPromptPlanWithAdmittedInventory> {
    preparedBehavior = null;
    composition = null;
    signal.throwIfAborted();
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
    const preparedStack = await prepareSessionPromptStackInputs({
      credentials: params.opts.credentials, metadata: params.session.getMetadataSnapshot(), sessionId: params.session.sessionId,
      machineId: params.machineId, directory: params.directory, signal,
      accountContext: { ...accountContext, settings: params.opts.accountSettingsContext?.settings ?? null },
    });
    const { accountSnapshot: currentAccount, assertCurrentAccount, ...stackInputs } = preparedStack;
    const { settings, profileId } = stackInputs;
    const plan = await resolveEffectiveCodingPromptPlan({
      ...stackInputs,
      compositionScope,
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
    }).catch((error: unknown) => {
      signal.throwIfAborted();
      // Failed preparation can carry private admission facts from the retired Account.
      assertCurrentAccount();
      throw error;
    });
    signal.throwIfAborted();
    // A document response may outlive the Account admission that requested it.
    assertCurrentAccount();
    const text = plan.text.trim().normalize('NFC');
    preparedBehavior = { accountSnapshot: currentAccount, settings, profileId, behavior: plan.codingPromptBehavior };
    composition = plan.composition;
    if (text !== resolvedText) {
      if (resolvedText !== null) revision += 1;
      startupInstructions = text ? AgentSessionStartupInstructionsV1Schema.parse({
        v: 1, id: 'happier.coding_session_plan', revision, instructions: text,
      }) : null;
      resolvedText = text;
    }
    return includeAdmittedInventory ? { text, admittedEntries: plan.admittedEntries } : text;
  }
  const isPreparedPlanCurrent = () => preparedBehavior !== null
    && (!accountScopeKey || (preparedBehavior.accountSnapshot === getActiveAccountSettingsSnapshot()
      && getActiveAccountSettingsSnapshotLifetimeToken() === accountLifetimeToken))
    && preparedBehavior.settings === (accountScopeKey ? getActiveAccountSettingsSnapshot()?.settings : params.opts.accountSettingsContext?.settings ?? null)
    && preparedBehavior.profileId === (params.session.getMetadataSnapshot()?.profileId ?? null);
  return Object.assign(resolve, { readStartupInstructions: () => !accountScopeKey
      || isActiveAccountSettingsSnapshotLifetimeCurrent({ scopeKey: accountScopeKey, lifetimeToken: accountLifetimeToken })
      ? startupInstructions : null,
    readCodingPromptBehavior: () => isPreparedPlanCurrent() ? preparedBehavior?.behavior ?? null : null,
    readComposition: () => isPreparedPlanCurrent() ? composition : null });
}
