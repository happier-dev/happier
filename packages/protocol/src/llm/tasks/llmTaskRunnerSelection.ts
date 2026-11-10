import { z } from '../../zodRuntimePolicy.js';

import { lazyZodSchema } from '../../lazyZodSchema.js';
import type { AcpConfigOptionOverridesV1 } from '../../sessions/metadata/metadataOverridesV1.js';
import { PROVIDER_REASONING_EFFORT_OPTION_ID } from '../../providers/catalog/reasoningEffort.js';
import type { ProviderBoundModelRef } from '../../providers/selection/v1.js';
import type { ConnectedServiceBindingsV2 } from '../../connect/connectedServiceBindings.js';
import type { CapabilitySupport } from '../../providers/capabilities/v1.js';
import type { ProviderModelDescriptorV1 } from '../../models/descriptor.js';
import {
  isLlmTaskRunnerAutoV1,
  type LlmTaskPermissionMode,
  type LlmTaskRunnerChoiceV1,
  type LlmTaskRunnerConfigV1,
  LlmTaskRunnerConfigV1WriteSchema,
} from './llmTaskRunnerConfigV1.js';

/** Background tasks whose runner this owner picks. */
export const LLM_TASK_IDS_V1 = Object.freeze(['memory_hints', 'scm_commit_message', 'scm_diff_summary', 'session_replay_summary'] as const);
export type LlmTaskIdV1 = typeof LLM_TASK_IDS_V1[number];
export const LlmTaskIdV1Schema = lazyZodSchema(() => z.enum(LLM_TASK_IDS_V1));

/**
 * What a task needs. Tasks declare; only `resolveLlmTaskRunnerV1` decides.
 * A provider's `low` cost tier is its cheap, fast tier (for example Haiku or Luna).
 */
export type LlmTaskDeclarationV1 = Readonly<{
  /** The task parses JSON output, so Auto skips models without supported structured output. */
  structuredOutput: 'required' | 'optional';
  /** Permission levels a person may choose. The first one is the task's default. */
  permissionModes: readonly [LlmTaskPermissionMode, ...LlmTaskPermissionMode[]];
  /** `low_only`: Auto uses only low-tier models. `cheapest_first`: Auto takes the lowest tagged tier. */
  costTiers: 'low_only' | 'cheapest_first';
}>;

export const LLM_TASK_DECLARATIONS_V1: Readonly<Record<LlmTaskIdV1, LlmTaskDeclarationV1>> = Object.freeze({
  memory_hints: { structuredOutput: 'required', permissionModes: ['no_tools', 'read_only'], costTiers: 'cheapest_first' },
  // Fast: the low tier ranks first. Its prompt asks for JSON. Commit generation is never tool-capable.
  scm_commit_message: { structuredOutput: 'required', permissionModes: ['no_tools'], costTiers: 'cheapest_first' },
  scm_diff_summary: { structuredOutput: 'required', permissionModes: ['read_only'], costTiers: 'low_only' },
  session_replay_summary: { structuredOutput: 'optional', permissionModes: ['no_tools', 'read_only'], costTiers: 'cheapest_first' },
});

const LLM_TASK_RUNNER_UNAVAILABLE_REASONS_V1 = ['not_enabled', 'not_installed', 'sign_in_required', 'auth_unavailable',
  'connected_default_unavailable', 'account_metadata_unavailable'] as const;
/** Why an Agent on the executing machine cannot run a task right now. */
export type LlmTaskRunnerUnavailableReasonV1 = typeof LLM_TASK_RUNNER_UNAVAILABLE_REASONS_V1[number];

/** One model an enabled Agent can run on the executing machine, through its current credential route. */
export type LlmTaskRunnerCandidateV1 = Readonly<{
  modelSelection: ProviderBoundModelRef;
  connectedServices?: ConnectedServiceBindingsV2 | null;
  title: string;
  costTier?: ProviderModelDescriptorV1['costTier'];
  structuredOutput?: CapabilitySupport;
  /** The model's own effort values, in the order its catalog declares them (lowest first). */
  effortValues?: readonly string[];
}>;

export type LlmTaskRunnerUnavailableAgentV1 = Readonly<{ agentTargetKey: string; reason: LlmTaskRunnerUnavailableReasonV1 }>;

export type LlmTaskRunnerResolutionV1<C extends LlmTaskRunnerCandidateV1 = LlmTaskRunnerCandidateV1> =
  | Readonly<{ ok: true; source: 'explicit'; runner: LlmTaskRunnerConfigV1 }>
  | Readonly<{ ok: true; source: 'auto'; runner: LlmTaskRunnerConfigV1; title: string; candidate: C }>
  | Readonly<{
    ok: false;
    errorCode: 'LLM_TASK_RUNNER_UNAVAILABLE';
    /** `no_ready_agent`: no enabled Agent can run now. `no_matching_model`: ready Agents offer no model this task can use. */
    reason: 'no_ready_agent' | 'no_matching_model';
    unavailableAgents: readonly LlmTaskRunnerUnavailableAgentV1[];
  }>;

const COST_TIER_RANK = { low: 0, standard: 1, premium: 2 } as const;

function readPermissionMode(task: LlmTaskDeclarationV1, requested: LlmTaskPermissionMode | undefined): LlmTaskPermissionMode {
  return requested && task.permissionModes.includes(requested) ? requested : task.permissionModes[0];
}

/**
 * The one owner of "which Agent + model + connected service + effort + permission
 * level runs this background task". The person's explicit choice always wins
 * unchanged. Auto takes the cheapest model among every enabled Agent that is ready
 * on the machine; the Session's own Agent wins a tie, then catalog order. It asks
 * for the model's lowest effort unless the person set one. A disabled, signed-out
 * or unavailable Agent is never used; nothing fits ⇒ a typed failure.
 */
export function resolveLlmTaskRunnerV1<C extends LlmTaskRunnerCandidateV1>(params: Readonly<{
  task: LlmTaskIdV1;
  choice: LlmTaskRunnerChoiceV1 | null | undefined;
  /** Ready models of enabled Agents on the executing machine, in catalog order. */
  candidates: readonly C[];
  /** Agents present on the machine that cannot run now; their models are never picked. */
  unavailableAgents?: readonly LlmTaskRunnerUnavailableAgentV1[];
  /** The Session's own Agent, which wins a cost tie. */
  sessionAgentTargetKey?: string | null;
}>): LlmTaskRunnerResolutionV1<C> {
  const task = LLM_TASK_DECLARATIONS_V1[params.task];
  const choice = params.choice;
  if (!isLlmTaskRunnerAutoV1(choice)) {
    return { ok: true, source: 'explicit', runner: { ...choice, permissionMode: readPermissionMode(task, choice.permissionMode) } };
  }
  const unavailableAgents = params.unavailableAgents ?? [];
  const unavailableKeys = new Set(unavailableAgents.map(agent => agent.agentTargetKey));
  const ready = params.candidates.filter(candidate => !unavailableKeys.has(candidate.modelSelection.agentTargetKey));
  const eligible = ready.filter(candidate => (task.structuredOutput === 'optional' || candidate.structuredOutput === 'supported')
    && (task.costTiers === 'cheapest_first' || candidate.costTier === 'low'));
  const picked = pickCheapest(eligible, params.sessionAgentTargetKey ?? null);
  if (!picked) {
    return { ok: false, errorCode: 'LLM_TASK_RUNNER_UNAVAILABLE', reason: ready.length > 0 ? 'no_matching_model' : 'no_ready_agent', unavailableAgents };
  }
  const effort = choice?.sessionConfigOptionOverrides ?? lowestEffortOverrides(picked);
  return { ok: true, source: 'auto', title: picked.title, candidate: picked, runner: {
    v: 1,
    modelSelection: picked.modelSelection,
    ...(picked.connectedServices !== undefined ? { connectedServices: picked.connectedServices } : {}),
    ...(effort ? { sessionConfigOptionOverrides: effort } : {}),
    permissionMode: readPermissionMode(task, choice?.permissionMode),
  } };
}

/**
 * Lowest tagged tier across all candidates; the Session's Agent wins a tie, then
 * catalog order. An untagged model is never assumed cheap: only when no candidate
 * is tagged does Auto take one Agent (the Session's, else the first in catalog
 * order) and its catalog `default`, else its first model.
 */
function pickCheapest<C extends LlmTaskRunnerCandidateV1>(models: readonly C[], sessionAgentTargetKey: string | null): C | null {
  const isSession = (model: C) => model.modelSelection.agentTargetKey === sessionAgentTargetKey;
  let picked: C | null = null;
  for (const model of models) {
    if (!model.costTier) continue;
    if (!picked?.costTier) { picked = model; continue; }
    const delta = COST_TIER_RANK[model.costTier] - COST_TIER_RANK[picked.costTier];
    if (delta < 0 || (delta === 0 && isSession(model) && !isSession(picked))) picked = model;
  }
  if (picked) return picked;
  const agentKey = models.find(isSession)?.modelSelection.agentTargetKey ?? models[0]?.modelSelection.agentTargetKey;
  const agentModels = models.filter(model => model.modelSelection.agentTargetKey === agentKey);
  return agentModels.find(model => model.modelSelection.modelId === 'default') ?? agentModels[0] ?? null;
}

/** The model's own lowest declared effort; nothing when the model declares none. */
function lowestEffortOverrides(model: LlmTaskRunnerCandidateV1): AcpConfigOptionOverridesV1 | null {
  const lowest = model.effortValues?.[0];
  return lowest === undefined ? null
    : { v: 1, updatedAt: 0, overrides: { [PROVIDER_REASONING_EFFORT_OPTION_ID]: { value: lowest, updatedAt: 0 } } };
}

/** Wire projection of a resolution, as the executing machine reports it to a picker or a starter. */
export const LlmTaskRunnerResolutionWireV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ ok: z.literal(true), source: z.enum(['explicit', 'auto']), runner: LlmTaskRunnerConfigV1WriteSchema, title: z.optional(z.string()) }),
  z.strictObject({
    ok: z.literal(false),
    errorCode: z.literal('LLM_TASK_RUNNER_UNAVAILABLE'),
    reason: z.enum(['no_ready_agent', 'no_matching_model']),
    unavailableAgents: z.array(z.strictObject({ agentTargetKey: z.string(), reason: z.enum(LLM_TASK_RUNNER_UNAVAILABLE_REASONS_V1) })),
  }),
]));
export type LlmTaskRunnerResolutionWireV1 = z.infer<typeof LlmTaskRunnerResolutionWireV1Schema>;

export function projectLlmTaskRunnerResolutionWireV1(resolution: LlmTaskRunnerResolutionV1): LlmTaskRunnerResolutionWireV1 {
  if (!resolution.ok) return { ok: false, errorCode: resolution.errorCode, reason: resolution.reason, unavailableAgents: [...resolution.unavailableAgents] };
  return { ok: true, source: resolution.source, runner: resolution.runner, ...(resolution.source === 'auto' ? { title: resolution.title } : {}) };
}
