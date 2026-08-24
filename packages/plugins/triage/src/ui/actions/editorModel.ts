import type { TriageActionV1 } from '../../settings/actions.js';
import { TRIAGE_WORKSPACE_MODES_V1 } from '../../sessions/entrySessionWorkspace.js';
import { TRIAGE_ACTION_DELIVERIES_V1 } from '../../settings/actions.js';
import { TRIAGE_SOURCE_WORKFLOW_SUBJECTS_V1 } from '@happier-dev/triage-protocol/v1';
import type { TriageSourceWorkflowSubjectV1 } from '@happier-dev/triage-protocol/v1';
import type { TriageActionEditorDraftV1 } from './actionsCommand.js';

/**
 * The editor's draft, and the pure rules that move it.
 *
 * The component holds one draft and renders controls; every decision about what
 * a control DOES lives here, so the same rules can be exercised without a mount.
 * None of it is a second authority: `settings/actions.ts` still refuses an empty
 * subject set, a repeated subject, and an over-long label. This module keeps the controls from offering a draft the writer will
 * certainly refuse, which is a different job from deciding whether it is valid.
 */

/** Every closed vocabulary the editor offers, in one declared order. */
export const TRIAGE_EDITOR_SUBJECTS_V1: readonly TriageSourceWorkflowSubjectV1[] =
  Object.freeze([...TRIAGE_SOURCE_WORKFLOW_SUBJECTS_V1]);
export const TRIAGE_EDITOR_WORKSPACE_MODES_V1 = TRIAGE_WORKSPACE_MODES_V1;
export const TRIAGE_EDITOR_DELIVERIES_V1 = TRIAGE_ACTION_DELIVERIES_V1;
export const TRIAGE_EDITOR_TARGET_KINDS_V1 = ['agent', 'reviewStart'] as const;
export type TriageEditorTargetKindV1 = (typeof TRIAGE_EDITOR_TARGET_KINDS_V1)[number];

export type TriagePromptInvocationEditorOptionV1 = Readonly<{
  value: string;
  label: string;
}>;

/**
 * Projects the Prompt Library inventory into the editor without turning an
 * incomplete read into a deletion claim.
 *
 * The held reference is retained even when it is absent from the returned
 * rows. Only `complete` is authoritative enough to label that absence as
 * deleted; `truncated` and an unavailable read (`null`) show the stable id the
 * action still holds.
 */
export function triagePromptInvocationEditorOptionsV1(input: Readonly<{
  heldInvocationId: string | null;
  invocations: readonly Readonly<{ id: string; token: string; title: string }>[];
  coverage: 'complete' | 'truncated' | null;
  noPromptLabel: string;
  missingPromptLabel: string;
}>): readonly TriagePromptInvocationEditorOptionV1[] {
  const rows = input.invocations.map((invocation) => ({
    value: invocation.id,
    label: `${invocation.token} — ${invocation.title}`,
  }));
  const held = input.heldInvocationId;
  const missing = held !== null && !rows.some((row) => row.value === held)
    ? [{
      value: held,
      label: input.coverage === 'complete' ? input.missingPromptLabel : held,
    }]
    : [];
  return [{ value: '', label: input.noPromptLabel }, ...rows, ...missing];
}

/**
 * What a brand-new action starts as.
 *
 * It applies to every subject and needs nothing materialized, which is the one
 * combination that is offered everywhere and refused nowhere — so a person who
 * presses **Add** and types a name has a working action before they have read a
 * single other control.
 */
export function newTriageActionDraftV1(): TriageActionEditorDraftV1 {
  return {
    label: '',
    enabled: true,
    appliesTo: TRIAGE_EDITOR_SUBJECTS_V1,
    profileId: null,
    workspaceMode: 'reference_only',
    target: { kind: 'agent', promptInvocationId: null, delivery: 'compose' },
  };
}

/** The stored action, opened for editing. */
export function triageActionDraftV1(action: TriageActionV1): TriageActionEditorDraftV1 {
  return {
    label: action.label,
    enabled: action.enabled,
    appliesTo: action.appliesTo,
    profileId: action.profileId,
    workspaceMode: action.workspaceMode,
    target: action.target,
  };
}

/**
 * Switch the arm without losing what the other arm was configured with.
 *
 * `reviewStart` carries no `delivery` because starting review runs is the only
 * delivery it has, so a switch to it drops that member. The prompt reference
 * SURVIVES the switch in both directions: it answers the same question on both
 * arms — what the reader wants looked at — and dropping it would silently
 * discard a configuration for changing an unrelated member. Nothing infers the
 * arm from the label at any point.
 */
export function withTriageActionTargetKindV1(
  draft: TriageActionEditorDraftV1,
  kind: TriageEditorTargetKindV1,
): TriageActionEditorDraftV1 {
  if (draft.target.kind === kind) return draft;
  const promptInvocationId = draft.target.promptInvocationId;
  return {
    ...draft,
    target: kind === 'reviewStart'
      ? { kind: 'reviewStart', promptInvocationId }
      : { kind: 'agent', promptInvocationId, delivery: 'compose' },
  };
}

/**
 * The Prompt Library's own STABLE invocation id, trimmed, with an empty field
 * meaning "no prompt" rather than an empty reference.
 *
 * The grammar itself is deliberately NOT restated here. The Library owns what
 * an id looks like, and an id that names no invocation is a resolution failure
 * the press reports with the person's own configuration in front of them —
 * re-spelling that rule in an editor would be a second grammar that drifts.
 */
export function withTriagePromptTokenV1(
  draft: TriageActionEditorDraftV1,
  token: string,
): TriageActionEditorDraftV1 {
  const trimmed = token.trim();
  const promptInvocationId = trimmed.length === 0 ? null : trimmed;
  return {
    ...draft,
    target: draft.target.kind === 'reviewStart'
      ? { kind: 'reviewStart', promptInvocationId }
      : { kind: 'agent', promptInvocationId, delivery: draft.target.delivery },
  };
}

export function withTriageDeliveryV1(
  draft: TriageActionEditorDraftV1,
  delivery: (typeof TRIAGE_ACTION_DELIVERIES_V1)[number],
): TriageActionEditorDraftV1 {
  if (draft.target.kind !== 'agent') return draft;
  return {
    ...draft,
    target: {
      kind: 'agent',
      promptInvocationId: draft.target.promptInvocationId,
      delivery,
    },
  };
}

/** A Launch Profile id, with an empty field meaning "let New Session choose". */
export function withTriageProfileIdV1(
  draft: TriageActionEditorDraftV1,
  profileId: string,
): TriageActionEditorDraftV1 {
  const trimmed = profileId.trim();
  return { ...draft, profileId: trimmed.length === 0 ? null : trimmed };
}

/**
 * Keep the offered subject set in the vocabulary's own order and free of
 * repeats.
 *
 * A multi-select hands back whatever order the person touched the options in,
 * and the writer refuses a repeated subject outright — so normalizing here is
 * what keeps an ordinary click from becoming a rejected write.
 */
export function withTriageAppliesToV1(
  draft: TriageActionEditorDraftV1,
  subjects: readonly string[],
): TriageActionEditorDraftV1 {
  const chosen = new Set(subjects);
  return {
    ...draft,
    appliesTo: TRIAGE_EDITOR_SUBJECTS_V1.filter((subject) => chosen.has(subject)),
  };
}

/**
 * Whether the draft is worth sending at all.
 *
 * These are the two refusals a person can reach by leaving a control alone: an
 * unnamed action and an action offered on nothing. Everything else the writer
 * enforces is unreachable from these controls, so it is not restated — the
 * writer's answer is the one that reaches them.
 */
export function triageActionDraftBlockerV1(
  draft: TriageActionEditorDraftV1,
): 'label' | 'appliesTo' | null {
  if (draft.label.trim().length === 0) return 'label';
  if (draft.appliesTo.length === 0) return 'appliesTo';
  return null;
}
