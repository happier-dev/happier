import type {
  AgentNativeResumeIdentityV1,
  RuntimeDescriptorV1,
  SessionMetadata,
} from '@happier-dev/protocol';

import type { AgentId } from '../../types.js';
import { getAgentResumeConfig } from '../../manifest.js';
import { writeProviderSessionIdSessionState } from './bindings/providerSessionId.js';
import { clearSessionStateFieldFromMetadata } from './bindings/publishField.js';
import { writeRuntimeDescriptorSessionState } from './bindings/runtimeDescriptor.js';

/**
 * Disposition of the Agent-scoped current projections a departing runtime left
 * behind (section 8 of the cross-Agent continuation contract).
 *
 * - `carry` keeps them. Physical Session handoff moves the SAME Agent to
 *   another machine, so its work state, commands, capabilities and intents are
 *   still true after the move.
 * - `clear` drops them so the incoming Agent republishes its own. Session-global
 *   facts — identity, workspace, permission intent, history, cursors, terminal —
 *   are carried in both modes.
 */
export type CurrentAgentSessionViewStatePolicyV1 = 'carry' | 'clear';

export type ProjectCurrentAgentSessionViewParamsV1 = Readonly<{
  /** The Agent this Session's current view must declare. */
  agentId: AgentId;
  /**
   * Matched native resume identity for the target, or `null`/omitted for a
   * fresh target. The proof is nested inside the pair so an id can never be
   * written without discarding a proof that belonged to a different id.
   */
  nativeResumeIdentity?: AgentNativeResumeIdentityV1 | null;
  /** Target runtime descriptor, or `null`/omitted to leave the view without one. */
  runtimeDescriptor?: RuntimeDescriptorV1 | null;
  /** Defaults to `carry`; the Agent transition passes `clear`. */
  agentScopedCurrentState?: CurrentAgentSessionViewStatePolicyV1;
}>;

/**
 * Agent-scoped current projections that have no session-state field of their
 * own. Everything that DOES have one is cleared through
 * `clearSessionStateFieldFromMetadata` so the field's key list stays owned in
 * one place.
 */
const AGENT_SCOPED_CURRENT_METADATA_KEYS: readonly string[] = Object.freeze([
  // Slash commands, tools, capabilities and facets — the target republishes its own.
  'slashCommands',
  'slashCommandDetails',
  'tools',
  'agentRuntimeCapabilitiesV1',
  'agentRuntimeFacetsV1',
  'mcpSelectionV1',
  // Mode/model/config catalogs and applied values belonging to the source Agent.
  'acpSessionModesV1',
  'sessionModesV1',
  'acpSessionModelsV1',
  'sessionModelsV1',
  'acpConfigOptionsV1',
  'sessionConfigOptionsV1',
  'sessionAppliedModelV1',
  'providerBindingV1',
  // Current work headlines derived from the source runtime's activity.
  'sessionWorkflowActivityHeadlineV1',
  'sessionAgentActivityHeadlineV1',
]);

/**
 * Session-state fields whose current value belongs to the departing Agent.
 * Their metadata keys are owned by `clearSessionStateFieldFromMetadata`.
 */
const AGENT_SCOPED_CURRENT_STATE_FIELDS = [
  'runtime.workState',
  'runtime.activity',
  'runtime.externalAgent',
  'runtime.usageLimitRecovery',
  'intent.model',
  'intent.acpSessionMode',
  'intent.acpConfigOption',
] as const;

/**
 * The one pure projector for "this Session's current view is now Agent X".
 *
 * It seals three things that were previously re-derived by every writer:
 *
 * 1. **Declared identity** — `flavor` and the runtime descriptor name the target.
 * 2. **One flat vendor key** — every Agent's flat resume key and continuity proof
 *    is cleared first, then only the target's matched pair is written. This is
 *    `REQ-STATE-01`: a view that carries two keys has no authoritative identity
 *    and, before this owner existed, could not be resumed at all.
 * 3. **State disposition** — Agent-scoped current projections are cleared or
 *    carried per section 8, while Session-global facts always survive.
 *
 * It is pure: the input metadata is never mutated. It applies no intent of its
 * own — a selected target model/mode/config is applied afterwards through the
 * canonical intent writers, and the cleared state IS the "target default" that
 * an omitted selection means.
 */
export function projectCurrentAgentSessionView<TMetadata extends SessionMetadata>(
  metadata: TMetadata,
  params: ProjectCurrentAgentSessionViewParamsV1,
): TMetadata {
  // Clearing the field drops every Agent's flat resume key AND its catalog-declared
  // continuity proof, so the target's key below is the only one that can remain.
  let next = clearSessionStateFieldFromMetadata(
    { ...metadata, flavor: params.agentId } as SessionMetadata,
    'identity.providerSessionId',
  ) as Record<string, unknown>;

  const vendorResumeIdMetadataKey = getAgentResumeConfig(params.agentId).vendorResumeIdField ?? null;
  const nativeResumeIdentity = params.nativeResumeIdentity ?? null;
  if (vendorResumeIdMetadataKey && nativeResumeIdentity) {
    // The id/proof pair goes through the one vendor-resume writer, which owns
    // the atomic "write the id, rewrite its proof slot" rule. An Agent whose
    // catalog declares no proof field simply has no slot, so a proof handed to
    // the wrong Agent is dropped rather than left as an unowned local path.
    next = writeProviderSessionIdSessionState(next, {
      metadataKey: vendorResumeIdMetadataKey,
      value: nativeResumeIdentity.vendorResumeId,
      continuityProof: nativeResumeIdentity.continuityProof,
    });
  }

  next = writeRuntimeDescriptorSessionState(
    next as SessionMetadata,
    params.runtimeDescriptor ?? null,
  ) as Record<string, unknown>;
  if (!params.runtimeDescriptor) {
    next = clearSessionStateFieldFromMetadata(
      next as SessionMetadata,
      'identity.runtimeDescriptor',
    ) as Record<string, unknown>;
  }

  if ((params.agentScopedCurrentState ?? 'carry') === 'clear') {
    for (const fieldId of AGENT_SCOPED_CURRENT_STATE_FIELDS) {
      next = clearSessionStateFieldFromMetadata(next as SessionMetadata, fieldId) as Record<string, unknown>;
    }
    next = { ...next };
    for (const key of AGENT_SCOPED_CURRENT_METADATA_KEYS) {
      delete next[key];
    }
  }

  return next as TMetadata;
}
