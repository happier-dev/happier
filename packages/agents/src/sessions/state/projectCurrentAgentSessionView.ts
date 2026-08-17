import { AGENTS_CORE } from '../../manifest.js';
import { AGENT_IDS, type AgentId } from '../../types.js';

/**
 * The one place a Session's decrypted metadata is rewritten to name a different
 * current Agent.
 *
 * Every consumer of that metadata resolves "which Agent is this Session?" from
 * the same three signals — declared `flavor`, the runtime descriptor, and the
 * flat per-Agent vendor resume keys — and
 * `buildInactiveSessionResumeSpawnOptions` REFUSES to build resume options when
 * those signals disagree (it requires exactly one identity candidate). So a
 * cutover that writes the target's identity without removing the source's key
 * produces a Session that still reports an Agent but can never be reactivated
 * from its own committed metadata. That failure is silent at the identity
 * resolver and loud only at resume, which is why the removal lives here, beside
 * the manifest that enumerates the keys, rather than in a caller.
 *
 * This projector is intentionally CLEAR-LIST driven rather than carry-list
 * driven: session metadata is an open record shared by many owners, so an
 * allow-list would silently drop unrelated facts (workspace location, handoff
 * lineage, fork/replay metadata, connected services) the transition must
 * preserve. What it removes is exactly the set of Agent-scoped facts and
 * current-runtime projections that describe a runtime which no longer exists.
 */

/** Agent-scoped continuity/proof facts that are not the flat resume key itself. */
const AGENT_SCOPED_CONTINUITY_KEYS = [
  'claudeTranscriptPath',
  'claudeLastCheckpointId',
  'claudeLastAssistantUuid',
  'claudeSubscriptionAccessTokenRefreshV1',
  'piSessionFile',
  'codexBackendMode',
  'opencodeBackendMode',
  'opencodeServerBaseUrl',
  'opencodeServerBaseUrlExplicit',
  'auggieAllowIndexing',
  'agentRuntimeDescriptorV1',
  'acpConfiguredBackendV1',
  'acpTransportV1',
  'acpHistoryImportV1',
  'providerSessionInfoV1',
] as const;

/**
 * Current-runtime projections. Each is republished by whichever runtime is
 * attached; none is Session history. Historical facts — transcript, turns,
 * usage, rollback ranges, fork/replay lineage, handoff lineage — are NOT here.
 */
const CURRENT_RUNTIME_PROJECTION_KEYS = [
  'tools',
  'slashCommands',
  'slashCommandDetails',
  'capabilities',
  'localControl',
  'controlledByUser',
  'sessionWorkStateV1',
  'sessionWorkflowActivityHeadlineV1',
  'sessionAgentActivityHeadlineV1',
  'acpSessionModesV1',
  'sessionModesV1',
  'acpSessionModelsV1',
  'sessionModelsV1',
  'sessionAppliedModelV1',
  'acpConfigOptionsV1',
  'sessionConfigOptionsV1',
  // Both describe the DEPARTED runtime: a usage-limit recovery record names the
  // source Agent's provider account and its retry window, and an MCP selection
  // is a per-Agent choice the target never made. dev clears both (the recovery
  // record through its session-state field owner); the predecessor projector
  // had simply never listed them.
  'sessionUsageLimitRecoveryV1',
  'mcpSelectionV1',
] as const;

/**
 * Agent-specific selections. Cleared unconditionally, then rewritten from the
 * target selection when one was supplied: a source Agent's model id or session
 * mode id is meaningless to a different Agent, and carrying it over would let a
 * stale value survive as the target's "intent".
 */
const AGENT_SELECTION_KEYS = [
  'modelOverrideV1',
  'acpSessionModeOverrideV1',
  'sessionModeOverrideV1',
  'acpConfigOptionOverridesV1',
  'sessionConfigOptionOverridesV1',
] as const;

export type CurrentAgentSessionViewTargetV1 = Readonly<{
  agentId: AgentId;
  /** Target model intent. Omitted/null means "the target's own default". */
  modelId?: string | null;
  /** Target session/ACP mode intent. Omitted/null means "the target's own default". */
  sessionModeId?: string | null;
  /** Target config overrides, already validated by the caller's catalog. */
  sessionConfigOptionOverrides?: unknown;
  /** Timestamp stamped on every rewritten override so cross-device ordering holds. */
  updatedAtMs: number;
}>;

/**
 * Disposition of the Agent-scoped facts the source runtime left behind.
 *
 * - `clear` (default) is the Agent TRANSITION: a different Agent takes over, so
 *   its predecessor's continuity facts, current projections and selections are
 *   dropped and the target republishes its own.
 * - `carry` is physical Session HANDOFF: the SAME Agent moves to another
 *   machine, so those facts are still true and only the identity rewrite
 *   applies.
 *
 * Both modes enforce the one-flat-key invariant. That is precisely why handoff
 * routes through this owner rather than writing a resume key of its own: a
 * second writer reintroduces the multi-key state that makes a Session
 * unresumable, because `buildInactiveSessionResumeSpawnOptions` can only build
 * options from an unambiguous identity.
 */
export type CurrentAgentSessionViewStatePolicyV1 = 'carry' | 'clear';

function vendorResumeIdFieldsByAgent(): readonly string[] {
  const fields: string[] = [];
  for (const agentId of AGENT_IDS) {
    const resume = AGENTS_CORE[agentId].resume;
    const field = 'vendorResumeIdField' in resume ? resume.vendorResumeIdField ?? null : null;
    if (field) fields.push(field);
  }
  return fields;
}

/** Every flat metadata key that names an Agent's native conversation. */
export function listVendorResumeIdMetadataKeys(): readonly string[] {
  return vendorResumeIdFieldsByAgent();
}

/**
 * Produces the target Agent's current view from the source's decrypted metadata.
 *
 * The result satisfies the one-identity invariant by construction: exactly one
 * declared identity (`flavor`) and at most one flat vendor resume key — the
 * target's. Under the default `clear` policy it additionally carries no runtime
 * descriptor or configured-backend record from the source.
 */
export function projectCurrentAgentSessionView(params: Readonly<{
  metadata: Record<string, unknown>;
  target: CurrentAgentSessionViewTargetV1;
  /**
   * Native resume id to write for the target. Omitted means a FRESH target,
   * which is the Agent transition's contract in this tree — the predecessor
   * discards an inactive Agent's native state rather than storing it. Physical
   * handoff supplies the id it just established on the target machine.
   */
  nativeResumeId?: string | null;
  /** Defaults to `clear`; physical Session handoff passes `carry`. */
  agentScopedCurrentState?: CurrentAgentSessionViewStatePolicyV1;
}>): Record<string, unknown> {
  const next: Record<string, unknown> = { ...params.metadata };

  // Always: no Session may carry a second Agent's flat resume key, in either mode.
  for (const key of vendorResumeIdFieldsByAgent()) delete next[key];

  if ((params.agentScopedCurrentState ?? 'clear') === 'clear') {
    for (const key of AGENT_SCOPED_CONTINUITY_KEYS) delete next[key];
    for (const key of CURRENT_RUNTIME_PROJECTION_KEYS) delete next[key];
    for (const key of AGENT_SELECTION_KEYS) delete next[key];
  }

  next.flavor = params.target.agentId;

  const nativeResumeId = typeof params.nativeResumeId === 'string' ? params.nativeResumeId.trim() : '';
  if (nativeResumeId) {
    const resume = AGENTS_CORE[params.target.agentId].resume;
    const field = 'vendorResumeIdField' in resume ? resume.vendorResumeIdField ?? null : null;
    // An Agent with no declared resume field simply has nowhere to record one;
    // it stays a fresh target rather than borrowing another Agent's key.
    if (field) next[field] = nativeResumeId;
  }

  const updatedAt = params.target.updatedAtMs;
  const modelId = typeof params.target.modelId === 'string' ? params.target.modelId.trim() : '';
  if (modelId) {
    next.modelOverrideV1 = { v: 1, updatedAt, modelId };
  }

  const modeId = typeof params.target.sessionModeId === 'string' ? params.target.sessionModeId.trim() : '';
  if (modeId) {
    // Both keys are written because readers are split across the legacy and
    // current alias in this tree; a single key would leave one reader blind.
    const override = { v: 1, updatedAt, modeId };
    next.sessionModeOverrideV1 = override;
    next.acpSessionModeOverrideV1 = override;
  }

  if (params.target.sessionConfigOptionOverrides !== undefined && params.target.sessionConfigOptionOverrides !== null) {
    next.sessionConfigOptionOverridesV1 = params.target.sessionConfigOptionOverrides;
    next.acpConfigOptionOverridesV1 = params.target.sessionConfigOptionOverrides;
  }

  return next;
}
