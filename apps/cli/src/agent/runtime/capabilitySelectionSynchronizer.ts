import type { Metadata } from '@/api/types';
import type { DaemonControlRequestOptions } from '@/daemon/controlClient';
import { readCapabilityLaunchRestartFromMetadataV1, readSessionCapabilityAgentFactsV1, resolveCapabilityApplyTimingV1, type CapabilityApplyTimingInputV1 } from '@happier-dev/protocol/reach/capabilityApplyTimingV1';
import type { RestartSessionRunnerRequestV1, RestartSessionRunnerResultV1 } from '@happier-dev/protocol';
import type { SessionSkillsReapplyRunner } from '@/prompts/skills/runtime/reapplySessionSkills';
import type { RunnerSkillsTransports, RunnerSkillsResult } from '@/prompts/skills/runtime/resolveRunnerSkills';
import type { RunnerMcpRuleObservation } from '@/mcp/runtime/resolveRunnerMcpServers';
import { logger } from '@/ui/logger';
import { resolveSessionCapabilitiesV1 } from '@happier-dev/protocol/reach/resolveSessionCapabilitiesV1';
import { realpathReachRules } from '@/mcp/servers/createRealpathNormalizer';
import { FIRST_PARTY_SKILLS_V1 } from '@happier-dev/protocol/prompts/library/skills/firstPartySkillsV1';
import { areSessionCapabilitySelectionsEquivalentV1, type SessionCapabilitySelectionV1 } from '@happier-dev/protocol/reach/sessionCapabilitySelectionV1';
import { readAppliedSessionCapabilitySelectionFromMetadataV1, readSessionCapabilitySelectionFromMetadataV1,
  resolveSelectionRestartMarkersForStartupV1, patchCapabilitySelectionApplyV1,
  clearCapabilitySelectionApplyV1, readPendingCapabilityRuleApplyV1,
  type CapabilitySelectionApplyV1 } from '@happier-dev/protocol/reach/sessionCapabilityMetadataV1';

type SkillRuleObservation = NonNullable<RunnerSkillsResult['reach']>;

function describeRuleSelectionChange(applied: string | null, observed: string | null) {
  if (applied === null || observed === null) return { addedIds: null, removedIds: null };
  // These private strings come only from the canonical selected-ID projections below.
  const before: readonly string[] = JSON.parse(applied);
  const after: readonly string[] = JSON.parse(observed);
  const beforeIds = new Set(before), afterIds = new Set(after);
  return { addedIds: [...afterIds].filter(id => !beforeIds.has(id)), removedIds: [...beforeIds].filter(id => !afterIds.has(id)) };
}

export type CapabilitySelectionSynchronizerInput = Readonly<{
  session: Readonly<{
    sessionId: string;
    getMetadataSnapshot: () => Metadata | null;
    updateMetadataAsCurrentPublisher: (update: (metadata: Metadata) => Metadata) => Promise<void>;
  }>;
  agent: CapabilityApplyTimingInputV1['agent'];
  isStarted: () => boolean;
  isSettled: () => boolean;
  skillsRunner?: SessionSkillsReapplyRunner;
  skillsTransports?: RunnerSkillsTransports;
  initialSkillRules?: SkillRuleObservation;
  readSkillRules?: () => SkillRuleObservation | null;
  initialMcpRules?: RunnerMcpRuleObservation & Readonly<{ selectedServerIds: readonly string[] }>;
  readMcpRules?: () => RunnerMcpRuleObservation | null;
  /** Bound through the host's incumbent captured Account subscription. */
  subscribeAccountSettings?: (observe: () => void) => () => void;
  requestRestart?: (request: RestartSessionRunnerRequestV1, options: Pick<DaemonControlRequestOptions, 'signal'>) => Promise<RestartSessionRunnerResultV1>;
}>;

export function createCapabilitySelectionSynchronizer(input: CapabilitySelectionSynchronizerInput) {
  const initialMetadata = input.session.getMetadataSnapshot();
  let applied = readAppliedSessionCapabilitySelectionFromMetadataV1(initialMetadata);
  let desired = readSessionCapabilitySelectionFromMetadataV1(initialMetadata);
  let blocked = false;
  let restartAccepted = false;
  let applying: Promise<void> | null = null;
  let waitForNextSettlement = false;
  let metadataApplyScheduled = false;
  let observedAgentFacts = readSessionCapabilityAgentFactsV1(initialMetadata);
  let lastSettledTurnId: string | undefined;
  const lifetime = new AbortController();

  const ruleSelection = (observation: SkillRuleObservation, selection: SessionCapabilitySelectionV1) => {
    const ids = new Set([...observation.rules.map(rule => rule.skillId), ...(selection.skills?.forceIncludeSkillIds ?? []),
      ...FIRST_PARTY_SKILLS_V1.map(skill => skill.skillId)]);
    const resolved = resolveSessionCapabilitiesV1({ context: observation.context, mcp: null,
      isFeatureEnabled: featureId => observation.featureEnabled?.[featureId] === true,
      skills: { items: [...ids].map(skillId => ({ skillId, name: skillId })), rules: realpathReachRules(observation.rules) },
      selection, agentAcceptsUserMcp: false });
    return JSON.stringify(resolved.skills.items.filter(item => item.selected).map(item => item.id).sort());
  };
  const initialRules = input.initialSkillRules ?? input.readSkillRules?.();
  // Explicit launch resolution is positive evidence even if an earlier runner's
  // pending status survives. A preserved-process attach reading today's rules
  // still cannot infer native application from that observation alone.
  const appliedRuleBaseline = (kind: 'mcp' | 'skills', launch: string | null, observed: string | null = null) => {
    if (launch !== null) return { selection: launch, source: 'launch' as const };
    if (readPendingCapabilityRuleApplyV1(initialMetadata, kind)) return { selection: null, source: 'pending' as const };
    return { selection: observed, source: 'observed' as const };
  };
  const skillBaseline = appliedRuleBaseline('skills',
    input.initialSkillRules ? ruleSelection(input.initialSkillRules, applied) : null,
    initialRules ? ruleSelection(initialRules, applied) : null);
  let appliedSkillRules = skillBaseline.selection;
  let desiredSkillRules = initialRules ? ruleSelection(initialRules, desired) : appliedSkillRules;
  let skillRulesAvailable = initialRules != null;
  let appliedSkillRuleSource = skillBaseline.source;
  let observedSkillCatalog = initialRules?.catalog ?? null;
  let appliedSkillCatalog = appliedSkillRules === null ? null : observedSkillCatalog;
  const mcpRuleSelection = (observation: RunnerMcpRuleObservation, selection: SessionCapabilitySelectionV1) => {
    const resolved = resolveSessionCapabilitiesV1({ context: observation.context,
      mcp: { ...observation.settings, bindings: realpathReachRules(observation.settings.bindings) },
      mcpPluginItems: observation.mcpPluginItems.map(item => ({ ...item, rules: realpathReachRules(item.rules) })),
      skills: null, selection, agentAcceptsUserMcp: true });
    return JSON.stringify(resolved.mcp.items.filter(item => item.selected).map(item => item.id).sort());
  };
  const initialMcpRules = input.initialMcpRules;
  // Only the launch resolver establishes the applied server set. In particular,
  // an unavailable launch or preserved-process refusal is not today's empty set.
  // A retained pending status cannot invalidate that positive launch evidence.
  const mcpBaseline = appliedRuleBaseline('mcp', initialMcpRules
    ? JSON.stringify([...initialMcpRules.selectedServerIds].sort()) : null);
  const appliedMcpRules = mcpBaseline.selection;
  let desiredMcpRules = initialMcpRules ? mcpRuleSelection(initialMcpRules, desired) : appliedMcpRules;
  let mcpRulesAvailable = initialMcpRules != null;
  const appliedMcpRuleSource = mcpBaseline.source;
  const appliedMcpCatalog = appliedMcpRules === null ? null : initialMcpRules?.catalog ?? null;
  let observedMcpCatalog = initialMcpRules?.catalog ?? null;

  const observe = () => {
    const next = readSessionCapabilitySelectionFromMetadataV1(input.session.getMetadataSnapshot());
    const nextAgentFacts = readSessionCapabilityAgentFactsV1(input.session.getMetadataSnapshot());
    if (JSON.stringify(nextAgentFacts) !== JSON.stringify(observedAgentFacts)) blocked = false;
    observedAgentFacts = nextAgentFacts;
    if (!areSessionCapabilitySelectionsEquivalentV1(desired, next)) blocked = false;
    desired = next;
    const rules = input.readSkillRules?.();
    if (rules) {
      const nextRules = ruleSelection(rules, desired);
      if (nextRules !== desiredSkillRules) blocked = false;
      desiredSkillRules = nextRules;
      observedSkillCatalog = rules.catalog ?? null;
    }
    skillRulesAvailable = rules != null;
    const mcpRules = input.readMcpRules?.();
    if (mcpRules) {
      const nextRules = mcpRuleSelection(mcpRules, desired);
      if (nextRules !== desiredMcpRules) blocked = false;
      desiredMcpRules = nextRules;
      observedMcpCatalog = mcpRules.catalog ?? null;
    }
    mcpRulesAvailable = mcpRules != null;
  };
  const pending = () => ({
    mcp: !areSessionCapabilitySelectionsEquivalentV1({ mcp: applied.mcp }, { mcp: desired.mcp })
      || mcpRulesAvailable && desiredMcpRules !== appliedMcpRules,
    skills: !areSessionCapabilitySelectionsEquivalentV1({ skills: applied.skills }, { skills: desired.skills })
      || skillRulesAvailable && desiredSkillRules !== appliedSkillRules,
  });
  const publishReason = async (captured: Required<SessionCapabilitySelectionV1>, kinds: Readonly<{ mcp: boolean; skills: boolean }>,
    status: NonNullable<CapabilitySelectionApplyV1['mcp']>) => {
    await input.session.updateMetadataAsCurrentPublisher(metadata => {
      // Active presence can expire while the process remains alive. Restore the
      // known runtime baseline if an offline desired write carried no marker.
      const withAppliedBaseline = resolveSelectionRestartMarkersForStartupV1({ current: metadata, applied: {
        ...(kinds.mcp ? { mcp: applied.mcp } : {}), ...(kinds.skills ? { skills: applied.skills } : {}),
      } });
      const current = readSessionCapabilitySelectionFromMetadataV1(withAppliedBaseline);
      const mcpRulePending = mcpRulesAvailable ? desiredMcpRules !== appliedMcpRules : readPendingCapabilityRuleApplyV1(metadata, 'mcp');
      const skillRulePending = skillRulesAvailable ? desiredSkillRules !== appliedSkillRules : readPendingCapabilityRuleApplyV1(metadata, 'skills');
      return patchCapabilitySelectionApplyV1(withAppliedBaseline, {
        ...(kinds.mcp && areSessionCapabilitySelectionsEquivalentV1({ mcp: captured.mcp }, { mcp: current.mcp }) ? { mcp: {
          ...status, ...(mcpRulePending ? { source: 'rules' as const } : {}),
        } } : {}),
        ...(kinds.skills && areSessionCapabilitySelectionsEquivalentV1({ skills: captured.skills }, { skills: current.skills }) ? { skills: {
          ...status, ...(skillRulePending ? { source: 'rules' as const } : {}),
        } } : {}),
      });
    }).catch(() => {
      logger.debug('[CapabilitySelection] Apply status publication unavailable; selection remains pending');
    });
  };

  const apply = async () => {
    observe();
    if (lifetime.signal.aborted || !input.isStarted() || restartAccepted) return;
    const captured = desired;
    const capturedSkillRules = desiredSkillRules;
    const capturedMcpRules = desiredMcpRules;
    const capturedSkillCatalog = observedSkillCatalog;
    const capturedMcpCatalog = observedMcpCatalog;
    const capturedSkillRulesAvailable = skillRulesAvailable;
    const capturedMcpRulesAvailable = mcpRulesAvailable;
    const agent = readSessionCapabilityAgentFactsV1(input.session.getMetadataSnapshot()) ?? input.agent;
    const kinds = pending();
    const changes = {
      mcpSelection: !areSessionCapabilitySelectionsEquivalentV1({ mcp: applied.mcp }, { mcp: captured.mcp }),
      skillsSelection: !areSessionCapabilitySelectionsEquivalentV1({ skills: applied.skills }, { skills: captured.skills }),
      mcpRules: mcpRulesAvailable && desiredMcpRules !== appliedMcpRules,
      skillRules: skillRulesAvailable && desiredSkillRules !== appliedSkillRules,
    };
    // Restoration can withdraw a refusal while a busy request awaits its next
    // settlement. It never acknowledges an unavailable observation.
    for (const kind of ['mcp', 'skills'] as const) {
      const available = kind === 'mcp' ? mcpRulesAvailable : skillRulesAvailable;
      if (!kinds[kind] && available && readPendingCapabilityRuleApplyV1(input.session.getMetadataSnapshot(), kind)) {
        await input.session.updateMetadataAsCurrentPublisher(metadata => clearCapabilitySelectionApplyV1(metadata, kind));
      }
    }
    if (blocked) return;
    if (!kinds.mcp && !kinds.skills) {
      return;
    }
    // Rules can change without a desired-selection marker. Publish that pending
    // fact before waiting for settlement or native acknowledgment, through the
    // same status owner used for an apply refusal.
    if (kinds.skills && skillRulesAvailable && desiredSkillRules !== appliedSkillRules
      && !readPendingCapabilityRuleApplyV1(input.session.getMetadataSnapshot(), 'skills')) {
      await publishReason(captured, { mcp: false, skills: true }, { reason: 'next_turn' });
    }
    if (kinds.mcp && mcpRulesAvailable && desiredMcpRules !== appliedMcpRules
      && !readPendingCapabilityRuleApplyV1(input.session.getMetadataSnapshot(), 'mcp')) {
      await publishReason(captured, { mcp: true, skills: false }, { reason: 'next_turn' });
    }
    if (!input.isSettled() || waitForNextSettlement) return;
    const nativeChanged = !areSessionCapabilitySelectionsEquivalentV1(
      { skills: { ...applied.skills, forceIncludeSkillIds: [], forceExcludeSkillIds: [] } },
      { skills: { ...captured.skills, forceIncludeSkillIds: [], forceExcludeSkillIds: [] } });
    const launchRestart = readCapabilityLaunchRestartFromMetadataV1(input.session.getMetadataSnapshot());
    if (kinds.skills && !nativeChanged && agent.skillsLiveReload === 'supported' && input.skillsRunner) {
      const runner = input.skillsRunner;
      const capturedInput = runner.readInput();
      const { reapplySessionSkills } = await import('@/prompts/skills/runtime/reapplySessionSkills');
      const result = await reapplySessionSkills({ ...runner, readInput: () => capturedInput }, input.skillsTransports);
      if (result.applied === 'live') {
        await input.session.updateMetadataAsCurrentPublisher(metadata => resolveSelectionRestartMarkersForStartupV1({
          current: metadata, applied: { skills: captured.skills },
        }));
        applied = { ...applied, skills: captured.skills };
        appliedSkillRules = capturedSkillRules;
        appliedSkillCatalog = capturedSkillCatalog;
        appliedSkillRuleSource = 'observed';
        kinds.skills = false;
      }
    }
    if (!kinds.mcp && !kinds.skills) return;
    const timing = resolveCapabilityApplyTimingV1({ kind: kinds.mcp ? 'mcp_server' : nativeChanged ? 'native_skill' : 'skill',
      sessionRunning: true, agent: { ...agent, skillsLiveReload: 'unsupported' }, launchRestart });
    if (timing.t !== 'next_turn') {
      blocked = true;
      await publishReason(captured, kinds, { reason: timing.t, ...(timing.t === 'restart_to_apply' ? { restartBy: timing.restartBy } : {}) });
      return;
    }
    // The daemon rechecks active turns and approvals immediately before signaling.
    const requestRestart = input.requestRestart ?? (await import('@/daemon/controlClient')).requestDaemonSessionRunnerRestart;
    if (lifetime.signal.aborted || !input.isSettled()) return;
    logger.infoFile('[CapabilitySelection] Requesting runner refresh', {
      sessionId: input.session.sessionId,
      changes: { mcpSelection: kinds.mcp && changes.mcpSelection, skillsSelection: kinds.skills && changes.skillsSelection,
        mcpRules: kinds.mcp && changes.mcpRules, skillRules: kinds.skills && changes.skillRules },
      ruleBaselines: {
        skills: { source: appliedSkillRuleSource, unknown: appliedSkillRules === null, observedAvailable: capturedSkillRulesAvailable,
          appliedCatalog: appliedSkillCatalog, observedCatalog: capturedSkillCatalog,
          ...describeRuleSelectionChange(appliedSkillRules, capturedSkillRules) },
        mcp: { source: appliedMcpRuleSource, unknown: appliedMcpRules === null, observedAvailable: capturedMcpRulesAvailable,
          appliedCatalog: appliedMcpCatalog, observedCatalog: capturedMcpCatalog,
          ...describeRuleSelectionChange(appliedMcpRules, capturedMcpRules) },
      },
    });
    const result = await requestRestart({
      sessionId: input.session.sessionId, mode: 'force_current_cli', reason: 'capability_selection_change',
    }, { signal: lifetime.signal });
    if (lifetime.signal.aborted) return;
    if (result.ok && result.status === 'restarted') {
      restartAccepted = true;
      return;
    }
    const busy = result.status === 'busy' && (result.reasonCode === 'turn_in_progress' || result.reasonCode === 'approval_pending');
    waitForNextSettlement = busy;
    blocked = !busy;
    const refusal = result.reasonCode;
    const refusalTiming = refusal === 'windows_hosted_runner' || refusal === 'not_daemon_started' || refusal === 'not_remote_started'
      ? resolveCapabilityApplyTimingV1({ kind: kinds.mcp ? 'mcp_server' : 'native_skill', sessionRunning: true,
        agent: { ...agent, skillsLiveReload: 'unsupported' }, launchRestart: { refused: refusal } }) : null;
    await publishReason(captured, kinds, refusalTiming?.t === 'restart_to_apply'
      ? { reason: refusalTiming.t, restartBy: refusalTiming.restartBy }
      : { reason: busy ? 'next_turn' : result.status === 'missing_resume_snapshot' ? result.status : result.reasonCode ?? result.status });
  };

  const flush = (): Promise<void> => {
    if (applying) return applying.then(() => {
      // A settlement wake may arrive while the earlier busy-turn publication
      // is finishing. Drain that work, then apply the still-pending change.
      const kinds = pending();
      if (!lifetime.signal.aborted && input.isStarted() && input.isSettled() && !blocked && !restartAccepted
        && !waitForNextSettlement && (kinds.mcp || kinds.skills)) return flush();
      return undefined;
    });
    const attemptedSelection = desired;
    const attemptedSkillRules = desiredSkillRules;
    const attemptedMcpRules = desiredMcpRules;
    applying = apply().catch(async () => {
      if (lifetime.signal.aborted) return;
      blocked = true;
      await publishReason(desired, pending(), { reason: 'apply_failed' });
    }).finally(() => {
      applying = null;
      if (!lifetime.signal.aborted && !blocked && !waitForNextSettlement && !restartAccepted && input.isSettled()
        && (!areSessionCapabilitySelectionsEquivalentV1(attemptedSelection, desired) || attemptedSkillRules !== desiredSkillRules
          || attemptedMcpRules !== desiredMcpRules)) {
        void flush();
      }
    });
    return applying;
  };
  const syncFromMetadata = () => {
    if (lifetime.signal.aborted) return;
    observe();
    if (!input.isStarted() || metadataApplyScheduled) return;
    metadataApplyScheduled = true;
    void Promise.resolve().then(async () => {
      metadataApplyScheduled = false;
      await flush();
    }).catch(error => logger.debug('[CapabilitySelection] Apply status publication failed', { error: String(error) }));
  };
  const unsubscribeAccountSettings = input.subscribeAccountSettings?.(syncFromMetadata);
  return {
    syncFromMetadata,
    dispose: async () => { lifetime.abort(new Error('Capability selection synchronizer disposed')); unsubscribeAccountSettings?.(); },
    flushBeforeTurn: () => waitForNextSettlement ? Promise.resolve() : flush(),
    flushAfterSettledTurn: (turnId?: string) => {
      if (!input.isSettled()) return Promise.resolve();
      if (turnId !== undefined && turnId === lastSettledTurnId) return applying ?? Promise.resolve();
      lastSettledTurnId = turnId;
      waitForNextSettlement = false;
      return flush();
    },
  };
}
