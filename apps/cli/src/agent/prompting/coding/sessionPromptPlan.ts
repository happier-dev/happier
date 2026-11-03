import { isDeepStrictEqual } from 'node:util';
import { AgentSessionStartupInstructionsV1Schema } from '@happier-dev/protocol/runtime/agentSessionStartupInstructionsV1';
import type { AgentSessionStartupInstructionsV1, SessionRolePromptContextV1, CodingPromptBehaviorV1 } from '@happier-dev/protocol';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { HostSessionRuntimeRunOptions } from '@/agent/runtime/session/loop/runHostSessionRuntime';
import type { DaemonAgentRuntimeTurnContributionsBridge } from '@/agent/runtime/session/process/agentRuntimeDaemonTurnContributionsBridge';
import { resolveAgentToolsDelivery } from '@/agent/tools/happierTools/runtime/resolveAgentToolsDelivery';
import { renderSkillIndexV1 } from '@happier-dev/protocol/prompts/library/skills/skillIndexV1';
import type { SkillLibraryItemV1 } from '@happier-dev/protocol/prompts/library/skills/skillLibraryItemV1';
import type { SessionSkillPlanV1 } from '@happier-dev/protocol/prompts/library/skills/resolveSessionSkillPlanV1';
import { resolveCliFeatureDecision } from '@/features/featureDecisionService';
import { resolvePluginPromptAssetBlocks, resolvePluginToolPromptContributions } from '@/plugins/runtime/hooks/execution/dispatchAgentTurnHooks';
import { resolveEffectiveCodingPromptPlan } from './resolveEffectiveCodingPrompt';
import { prepareSessionPromptStackInputs } from './sessionPromptStack';
import { getActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshotLifetimeToken, isActiveAccountSettingsSnapshotLifetimeCurrent, readAccountProfilePromptStackSources } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import type { PromptStackAdmittedEntryV1 } from '@happier-dev/protocol/prompts/library/resolvePromptStackSystemAppendBlocksV1';
import { createPromptCompositionScope, type PromptPlanComposition } from '../promptComposition';
import type { SavedSecretOperationContextV1 } from '@/settings/secrets/hydrateSavedSecretCatalog';
import { configuration } from '@/configuration';
import { SESSION_CAPABILITY_NOTICE_SIDECAR_KEY, SessionCapabilityNoticeV1Schema } from '@happier-dev/protocol/sessions/messages/sessionCapabilityNoticeV1';
import { logger } from '@/ui/logger';
import { isSessionAgentChangeTitleToolAvailable, isSessionAgentToolAvailable } from '@/agent/tools/happierTools/resolveSessionNativeToolBridge';

type PromptPreparationAccountSnapshot = ReturnType<typeof getActiveAccountSettingsSnapshot>;

type PromptPreparationAccountChange = 'account-snapshot-unavailable' | 'account-scope-changed'
  | 'account-availability-changed' | 'account-settings-changed' | 'account-keys-changed' | 'account-profile-changed';
export type SessionPromptPlanWithdrawalReason = 'plan-unprepared' | 'account-lifetime-changed'
  | `active-${PromptPreparationAccountChange}` | `captured-${PromptPreparationAccountChange}`
  | 'prepared-settings-changed' | 'profile-selection-changed';

function readPromptPreparationSettingsBasis(settings: Record<string, unknown> | null | undefined,
  profileId: string | null, behavior: CodingPromptBehaviorV1) {
  // These preferences feed the coding composer and its selected Profile. UI,
  // Voice and creation-only defaults cannot withdraw an existing Session's plan.
  const enabledById = settings?.profileEnabledById;
  return {
    codingPromptBehaviorV1: settings?.codingPromptBehaviorV1,
    // Actions policy contributes title and opted-in compaction guidance. Other
    // Actions (including their approval policy) remain live at their own owner.
    sessionTitleToolAvailable: isSessionAgentChangeTitleToolAvailable({
      accountSettings: settings ?? {}, codingPromptBehavior: behavior,
    }),
    sessionCompactionToolAvailable: behavior.sessionCompactionNudge && isSessionAgentToolAvailable({
      accountSettings: settings ?? {}, codingPromptBehavior: behavior, toolName: 'session_compact',
    }),
    profiles: profileId ? settings?.profiles : undefined,
    profileEnabled: profileId && enabledById && typeof enabledById === 'object'
      ? Reflect.get(enabledById, profileId) : undefined,
  };
}

function readPromptPreparationProfileBasis(snapshot: NonNullable<PromptPreparationAccountSnapshot>, profileId: string | null) {
  if (!profileId) return null;
  const catalog = snapshot.profileCatalog;
  return {
    sources: readAccountProfilePromptStackSources(snapshot, { profileId }),
    catalog: catalog?.status === 'ready' ? {
      status: catalog.status, authority: catalog.authority, source: catalog.source,
      controlPhase: catalog.control?.record.phase ?? null,
      // The canonical source reader chooses native rows only after activation.
      // Another Profile's row and the census revision cannot change this layer.
      selectedRows: catalog.authority === 'active' || catalog.source === 'destination'
        ? catalog.records.filter(({ record }) => record.id === profileId) : [],
    } : catalog,
  };
}

function readPromptPreparationAccountChange(prepared: PromptPreparationAccountSnapshot,
  current: PromptPreparationAccountSnapshot, profileId: string | null,
  behavior: CodingPromptBehaviorV1): PromptPreparationAccountChange | null {
  if (prepared === current) return null;
  if (!prepared || !current) return 'account-snapshot-unavailable';
  if (prepared.scopeKey !== current.scopeKey) return 'account-scope-changed';
  // First network confirmation of equal Settings is hydration, not retirement.
  // Losing previously admitted availability still withdraws the plan.
  if (prepared.source !== 'none' && current.source === 'none') return 'account-availability-changed';
  if (!isDeepStrictEqual(readPromptPreparationSettingsBasis(prepared.settings, profileId, behavior),
    readPromptPreparationSettingsBasis(current.settings, profileId, behavior))) return 'account-settings-changed';
  if (!isDeepStrictEqual(prepared.settingsSecretsReadKeys, current.settingsSecretsReadKeys)) return 'account-keys-changed';
  if (!isDeepStrictEqual(readPromptPreparationProfileBasis(prepared, profileId),
    readPromptPreparationProfileBasis(current, profileId))) return 'account-profile-changed';
  // Prompt rows are retained for this dispatch. Independent catalog hydration
  // and source/history bookkeeping do not change its prompt authority facts.
  return null;
}

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
  /** Refuses a withdrawn plan independently of whether its instruction text is empty. */
  assertPreparedPlanCurrent?: () => void;
  /** Current full-plan identity, retained by this producer across native runtime replacement. */
  readStartupInstructions?: () => AgentSessionStartupInstructionsV1 | null;
  /** Policy from the same current prepared plan, unavailable after a failed preparation. */
  readCodingPromptBehavior?: () => CodingPromptBehaviorV1 | null;
  readComposition?: () => PromptPlanComposition | null;
}>;

/** One full-plan producer for native startup and immediately-before-dispatch revisions. */
export function createSessionPromptPlanResolver(params: Readonly<{
  opts: HostSessionRuntimeRunOptions;
  session: Pick<ApiSessionClient, 'sessionId' | 'getMetadataSnapshot' | 'enqueueSessionEventCommitted'>;
  agentId: string;
  machineId: string;
  directory: string;
  serverId?: string;
  memoryRecallGuidanceEnabled: boolean;
  readNativeSessionId: () => string | null;
  readSessionSkills?: () => Readonly<{ plan: SessionSkillPlanV1; indexItems: readonly SkillLibraryItemV1[] }> | null;
  resolveRoleContext?: (signal?: AbortSignal) => Promise<SessionRolePromptContextV1 | null>;
  daemonBridge?: DaemonAgentRuntimeTurnContributionsBridge;
  /** Captures fresh material from the same admitted Home/Account for one preparation. */
  readOperationContext?: () => SavedSecretOperationContextV1 | undefined;
}>): SessionPromptPlanResolver {
  const toolDelivery = resolveAgentToolsDelivery(params.agentId);
  let resolvedText: string | null = null;
  let optionalLibraryUnavailable = false;
  let revision = params.opts.agentSessionStartupInstructionsV1?.revision ?? 1;
  let startupInstructions: AgentSessionStartupInstructionsV1 | null = null;
  const compositionScope = createPromptCompositionScope();
  let composition: PromptPlanComposition | null = null;
  let preparedBehavior: Readonly<{ accountSnapshot: ReturnType<typeof getActiveAccountSettingsSnapshot>; settings: Record<string, unknown> | null;
    profileId: string | null; behavior: CodingPromptBehaviorV1; operationContext?: SavedSecretOperationContextV1;
    activeAccountSnapshot: ReturnType<typeof getActiveAccountSettingsSnapshot> }> | null = null;
  const accountScopeKey = params.opts.accountSettingsContext?.scopeKey;
  const accountLifetimeToken = getActiveAccountSettingsSnapshotLifetimeToken();
  const accountContext = {
    scopeKey: accountScopeKey ?? null, lifetimeToken: accountLifetimeToken,
  };
  const serverId = params.serverId ?? params.opts.credentials?.requesterSessionCredentialScope?.serverId ?? configuration.activeServerId;
  async function resolve(args: SessionPromptPlanResolveArgs & Readonly<{ includeAdmittedInventory: true }>): Promise<SessionPromptPlanWithAdmittedInventory>;
  async function resolve(args?: SessionPromptPlanResolveArgs): Promise<string>;
  async function resolve({ baseOverride, excludePluginIds, includeAdmittedInventory, signal = new AbortController().signal }:
    SessionPromptPlanResolveArgs & Readonly<{ includeAdmittedInventory?: boolean }> = {}): Promise<string | SessionPromptPlanWithAdmittedInventory> {
    preparedBehavior = null;
    composition = null;
    signal.throwIfAborted();
    const operationContext = params.readOperationContext?.();
    const activeAccountSnapshot = getActiveAccountSettingsSnapshot();
    const executionRunsFeatureEnabled = resolveCliFeatureDecision({
      featureId: 'execution.runs', env: process.env,
    }).state === 'enabled';
    const featureIds = executionRunsFeatureEnabled ? ['execution.runs'] : [];
    const scope = {
      sessionId: params.session.sessionId, machineId: params.machineId,
      featureIds, ...(excludePluginIds ? { excludePluginIds } : {}), signal,
    };
    let optionalPromptAssetsUnavailable = false;
    // Plugin augmentation and Account/Project source admission have independent
    // transports. Join them before composition, retaining the final Account
    // fences rather than serializing these reads or reusing an older plan.
    const sessionMetadata = params.session.getMetadataSnapshot();
    const [promptPreparation, stackPreparation] = await Promise.allSettled([
      (async () => params.daemonBridge
        ? await params.daemonBridge.resolvePrompt(scope)
        : {
            promptAssetBlocks: await resolvePluginPromptAssetBlocks({ ...scope, agentId: params.agentId,
              onOptionalUnavailable: () => { optionalPromptAssetsUnavailable = true; } }),
            optionalPromptAssetsUnavailable,
            toolPromptContributions: await resolvePluginToolPromptContributions(
              excludePluginIds ? { excludePluginIds } : undefined,
            ),
          })(),
      prepareSessionPromptStackInputs({
        credentials: params.opts.credentials, metadata: sessionMetadata, sessionId: params.session.sessionId,
        machineId: params.machineId, directory: params.directory, signal, serverId,
        operationContext,
        accountContext: { ...accountContext, settings: params.opts.accountSettingsContext?.settings ?? null },
      }),
    ]);
    // Do not leave an independent source read running after a failed IPC reply.
    if (promptPreparation.status === 'rejected') throw promptPreparation.reason;
    if (stackPreparation.status === 'rejected') throw stackPreparation.reason;
    const promptContributions = promptPreparation.value;
    const preparedStack = stackPreparation.value;
    const { accountSnapshot: currentAccount, assertCurrentAccount, ...stackInputs } = preparedStack;
    const { settings, profileId } = stackInputs;
    const skills = params.readSessionSkills?.();
    const skillIndex = skills?.plan.plan === 'index' && toolDelivery !== 'unsupported'
      ? renderSkillIndexV1(skills.indexItems, params.session.sessionId) : '';
    const plan = await resolveEffectiveCodingPromptPlan({
      ...stackInputs,
      sessionMetadata,
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
      promptAssetBlocks: skillIndex ? [...promptContributions.promptAssetBlocks,
        { id: 'skills.index', scope: 'user_prompt', text: skillIndex }] : promptContributions.promptAssetBlocks,
    }).catch(async (error: unknown) => {
      signal.throwIfAborted();
      // Failed preparation can carry private admission facts from the retired Account.
      assertCurrentAccount();
      if (operationContext && !await operationContext.isCurrent()) {
        throw Object.assign(new Error('context_source_unavailable'), { code: 'context_source_unavailable', reason: 'scope-retired' });
      }
      throw error;
    });
    signal.throwIfAborted();
    // A document response may outlive the Account admission that requested it.
    assertCurrentAccount();
    if (operationContext && !await operationContext.isCurrent()) {
      throw Object.assign(new Error('context_source_unavailable'), { code: 'context_source_unavailable', reason: 'scope-retired' });
    }
    const unavailable = promptContributions.optionalPromptAssetsUnavailable === true
      || plan.admittedEntries.some(entry => entry.outcome === 'unavailable' && entry.reason === 'not_found');
    if (unavailable && !optionalLibraryUnavailable) {
      const notice = SessionCapabilityNoticeV1Schema.parse({ v: 1, items: [
        { kind: 'prompt_library', name: 'Prompt library', code: 'prompt_library_unavailable' },
      ] });
      // Optional context preparation needs durable notice admission, not its Home ACK.
      await params.session.enqueueSessionEventCommitted({ type: 'message',
        message: 'Prompt library unavailable. Continuing without optional prompts.',
        [SESSION_CAPABILITY_NOTICE_SIDECAR_KEY]: notice,
      }, undefined, { awaitDelivery: false }).catch(() => logger.warn('[prompts] Session capability notice could not be committed'));
      signal.throwIfAborted();
      assertCurrentAccount();
      if (operationContext && !await operationContext.isCurrent()) {
        throw Object.assign(new Error('context_source_unavailable'), { code: 'context_source_unavailable', reason: 'scope-retired' });
      }
    }
    optionalLibraryUnavailable = unavailable;
    const text = plan.text.trim().normalize('NFC');
    preparedBehavior = { accountSnapshot: currentAccount, settings, profileId, behavior: plan.codingPromptBehavior, operationContext,
      activeAccountSnapshot: operationContext ? activeAccountSnapshot : getActiveAccountSettingsSnapshot() };
    assertPreparedPlanCurrent();
    // Keep the confirmed authority basis after accepting initial hydration, so
    // a later loss of availability still withdraws this admitted preparation.
    preparedBehavior = { ...preparedBehavior, activeAccountSnapshot: getActiveAccountSettingsSnapshot() };
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
  const readPreparedPlanWithdrawalReason = (): SessionPromptPlanWithdrawalReason | null => {
    if (!preparedBehavior) return 'plan-unprepared';
    const activeAccount = getActiveAccountSettingsSnapshot();
    const capturedAccount = preparedBehavior.operationContext?.readSnapshot();
    if (accountScopeKey) {
      if (getActiveAccountSettingsSnapshotLifetimeToken() !== accountLifetimeToken) return 'account-lifetime-changed';
      const activeChange = readPromptPreparationAccountChange(preparedBehavior.activeAccountSnapshot, activeAccount,
        preparedBehavior.profileId, preparedBehavior.behavior);
      if (activeChange) return `active-${activeChange}`;
      const capturedChange = readPromptPreparationAccountChange(preparedBehavior.accountSnapshot,
        preparedBehavior.operationContext ? capturedAccount ?? null : activeAccount, preparedBehavior.profileId, preparedBehavior.behavior);
      if (capturedChange) return `captured-${capturedChange}`;
    }
    const currentSettings = preparedBehavior.operationContext ? capturedAccount?.settings
      : accountScopeKey ? activeAccount?.settings : params.opts.accountSettingsContext?.settings ?? null;
    if (!isDeepStrictEqual(readPromptPreparationSettingsBasis(preparedBehavior.settings, preparedBehavior.profileId, preparedBehavior.behavior),
      readPromptPreparationSettingsBasis(currentSettings, preparedBehavior.profileId, preparedBehavior.behavior))) return 'prepared-settings-changed';
    if (preparedBehavior.profileId !== (params.session.getMetadataSnapshot()?.profileId ?? null)) return 'profile-selection-changed';
    return null;
  };
  const isPreparedPlanCurrent = () => readPreparedPlanWithdrawalReason() === null;
  const assertPreparedPlanCurrent = () => {
    const reason = readPreparedPlanWithdrawalReason();
    if (reason) {
      logger.infoFile('[prompts] Prepared coding plan withdrawn', { reason });
      throw Object.assign(new Error('context_source_unavailable'), {
        code: 'context_source_unavailable', status: 'preparation_pending', reason,
      });
    }
  };
  return Object.assign(resolve, { assertPreparedPlanCurrent, readStartupInstructions: () => isPreparedPlanCurrent()
      && (!accountScopeKey || isActiveAccountSettingsSnapshotLifetimeCurrent({ scopeKey: accountScopeKey, lifetimeToken: accountLifetimeToken }))
      ? startupInstructions : null,
    readCodingPromptBehavior: () => isPreparedPlanCurrent() ? preparedBehavior?.behavior ?? null : null,
    readComposition: () => isPreparedPlanCurrent() ? composition : null });
}
