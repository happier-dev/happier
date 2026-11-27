import { REVIEW_START_ACTION_ID_V1, type ActionId } from '../../actionIds.js';
import type { ActionExecuteResult, ActionExecutorContext, ActionExecutorDeps } from '../types.js';
import { resolveSessionIdFromInput } from '../sessionScope.js';
import { normalizeExecutionBackendOptionValue } from '../executionRuns.js';
import { readRecord } from '../../../inputs/inputRecords.js';
import { readReviewNarratorOptions } from '../../../inputs/inputOptions.js';
import { requiresReviewWorkflowCompositionV1, reviewReviewerIdForSelectionV1, type ReviewStartInput } from '../../../reviews/reviewStart.js';
import { reviewScopeForInput } from '../../../reviews/reviewEngines.js';
import { readActionFailureEnvelope } from '../actionFailureEnvelope.js';
import { isActionOutcomeUnknownErrorCodeV1 } from '../../actionExecutionResult.js';
import { reviewStartExecutionRunCompletion } from '../../specs/executionRunCompletion.js';

/** One native launch's selected inventory, retained privately through approval and dispatch. */
export type ReviewEngineAdmissionV1 = Readonly<{ inventory: unknown; costConsentRequired: boolean;
  selectedItems: ReadonlyMap<string, ReturnType<typeof readReviewNarratorOptions>[number] | undefined> }>;

/** Selection is shared by paid admission, availability, narration and execution. */
export function selectReviewEngineItemV1(engineId: string, profileId: string | undefined,
  defaults: ReturnType<typeof readReviewNarratorOptions>, profiles: ReturnType<typeof readReviewNarratorOptions>) {
  return (profileId ? profiles : defaults).find(item => item.value === normalizeExecutionBackendOptionValue(engineId)
    && (!profileId || item.profileId === profileId));
}

export async function readReviewStartEngineInventoryV1(deps: ActionExecutorDeps, input: ReviewStartInput,
  context: ActionExecutorContext, targetMachineId?: string | null): Promise<
    Readonly<{ ok: true; inventory: unknown }> | Readonly<{ ok: false; result: ActionExecuteResult }>> {
  const detached = input.target?.kind === 'detached' || context.actionCaller?.kind === 'workflowRun';
  const reviewers = input.steps?.flatMap(step => step.reviewers) ?? input.reviewers;
  const composition = requiresReviewWorkflowCompositionV1(input);
  const profileSelections = reviewers.flatMap((selection, index) => {
    if (selection.kind !== 'engine') return [];
    const launch = { ...input, ...selection, ...(!composition ? context.reviewReviewerLaunchInputs?.[index] : undefined) };
    return launch.profileId ? [{ engineId: selection.engineId, profileId: launch.profileId,
      ...(launch.profileSourceCustody ? { profileSourceCustody: launch.profileSourceCustody } : {}) }] : [];
  });
  try {
    const inventory = await deps.reviewEnginesList!({ sessionId: detached ? null : resolveSessionIdFromInput(input, context),
      // Selected rows retain the inventory owner's refusal instead of becoming unknown engines.
      ...(detached && targetMachineId ? { machineId: targetMachineId } : {}), includeDisabled: true,
      engineIds: [...new Set(reviewers.flatMap(selection => selection.kind === 'engine' ? [selection.engineId] : []))],
      ...(profileSelections.length > 0 ? { profileSelections } : {}), scope: reviewScopeForInput(input),
    }, context);
    return { ok: true, inventory };
  } catch (error) {
    const refusal = readActionFailureEnvelope(error);
    const round = input.reviewRoundSettlement === 'workflow' ? input.reviewRound : undefined;
    if (!round || !input.reviewReviewerId || !refusal || refusal.errorCode === 'action_failed'
      || isActionOutcomeUnknownErrorCodeV1(refusal.errorCode) || context.signal?.aborted) throw error;
    // Inventory refused before any native reviewer start; retain the Workflow's
    // settled reviewer outcome rather than turning it into a stranded leaf.
    return { ok: false, result: { ok: true,
      result: reviewStartExecutionRunCompletion.terminal({ intent: 'review',
        sessionId: detached ? null : resolveSessionIdFromInput(input, context),
        results: [{ key: input.reviewReviewerId, ...refusal }], reviewRound: round }, []),
    } };
  }
}

export async function prepareReviewEngineAdmissionV1(actionId: ActionId, input: unknown,
  deps: ActionExecutorDeps, context: ActionExecutorContext): Promise<Readonly<{ ok: true; admission: ReviewEngineAdmissionV1 }>
    | Readonly<{ ok: false; result: ActionExecuteResult }> | undefined> {
  if (actionId !== REVIEW_START_ACTION_ID_V1 || !deps.reviewEnginesList) return undefined;
  const review = input as ReviewStartInput;
  // Composition starts its native reviewers as ordinary Review Actions. Each leaf
  // admits its selected profile before that paid effect, rather than asking twice.
  if (requiresReviewWorkflowCompositionV1(review) || !review.reviewers.some(selection => selection.kind === 'engine')) return undefined;
  const machineId = context.externalActionTarget?.kind === 'machine'
    ? context.externalActionTarget.machineId : context.executionRunTargetMachineId;
  const read = await readReviewStartEngineInventoryV1(deps, review, context, machineId);
  if (!read.ok) return read;
  const inventory = read.inventory;
  const defaults = readReviewNarratorOptions(inventory);
  const profiles = readReviewNarratorOptions({ items: readRecord(inventory).selectionItems });
  const selectedItems = new Map(review.reviewers.flatMap((selection, index) => {
    if (selection.kind !== 'engine') return [];
    const launch = { ...review, ...selection, ...context.reviewReviewerLaunchInputs?.[index] };
    return [[review.reviewReviewerId ?? reviewReviewerIdForSelectionV1(index),
      selectReviewEngineItemV1(selection.engineId, launch.profileId, defaults, profiles)] as const];
  }));
  const costConsentRequired = [...selectedItems.values()].some(item => item?.disabled !== true && item?.costConsent !== undefined);
  return { ok: true, admission: { inventory, selectedItems, costConsentRequired } };
}
