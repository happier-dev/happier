import type { WorkflowDefinitionV1, WorkflowActionLeafV1, WorkflowActionFieldBindingV1, WorkflowBlock } from '../workflowV1.js';
import { StrictJsonValueSchema, type JsonValue } from '../../json/strictJsonValue.js';
import type { ScmComparison } from '../../scm/comparison.js';
import type { ScmComparisonCaptureInput } from '../../scm/diffSummary.js';
import type { ReviewRoundBindingV1 } from '../../reviews/reviewArtifactV1.js';
import { reviewReviewerIdForSelectionV1, type ReviewStartInput } from '../../reviews/reviewStart.js';
import { ReviewStartNativeTerminalValueV1Schema } from '../../actions/specs/executionRunCompletion.js';
import { zodSchemaToJsonSchemaObject } from '../../actions/actionInputJsonSchema.js';
import { PluginJsonSchemaV2Schema } from '../../plugins/contributions/jsonSchema.js';
import { MENTION_KIND_V1, buildMentionRefForKindV1 } from '../../runtime/input/mentionRefV1.js';
import { formatInlineReferenceTokenV1 } from '../../runtime/input/inlineReferenceTokenV1.js';
import { REVIEW_FINDINGS_VERIFY_ONLY_INSTRUCTIONS_V1 } from '../../reviews/reviewFindingsApplyInputV1.js';
import { document, input, literal, result } from './definitionParts.js';

/** One admitted pass; the Review record and aggregate owners decide coverage and attention. */
export function buildReviewStepsWorkflowV1(reviewInput: ReviewStartInput, reviewRound: ReviewRoundBindingV1,
  comparison?: ScmComparison, comparisonCapture?: ScmComparisonCaptureInput, transcriptInput?: string): Readonly<{ definition: WorkflowDefinitionV1; inputs: Record<string, JsonValue> }> {
  const inputs: Record<string, JsonValue> = {
    reviewInput: StrictJsonValueSchema.parse(reviewInput), reviewRound,
    previousRoundContext: null,
    ...(comparison ? { comparison: StrictJsonValueSchema.parse(comparison) } : {}),
    ...(comparisonCapture ? { comparisonCapture: StrictJsonValueSchema.parse(comparisonCapture) } : {}),
  };
  const declarations: WorkflowDefinitionV1['inputs'][number][] = [
    { name: 'reviewInput', valueType: 'json', required: true },
    { name: 'reviewRound', valueType: 'json', required: true },
    { name: 'previousRoundContext', valueType: 'json', required: false, default: null },
    ...(comparison ? [{ name: 'comparison', valueType: 'json' as const, required: true }] : []),
    ...(comparisonCapture ? [{ name: 'comparisonCapture', valueType: 'json' as const, required: true }] : []),
  ];
  const blocks: WorkflowBlock[] = [{ kind: 'action', id: 'prepare', name: 'Prepare the Review round', actionId: 'review.prepare_round', input: {
    reviewInput: input('reviewInput'), reviewRound: input('reviewRound'), previousRoundContext: input('previousRoundContext'),
    ...(comparison ? { comparison: input('comparison') } : {}),
    ...(comparisonCapture ? { comparisonCapture: input('comparisonCapture') } : {}),
  } }];
  const stages = reviewInput.steps ?? [{ kind: 'review' as const, reviewers: reviewInput.reviewers, instructions: reviewInput.instructions }];
  const stageIds: string[] = [];
  const { reviewers: _reviewers, steps: _steps, then: _then, reviewRound: _round,
    reviewReviewerId: _reviewerId, reviewRoundSettlement: _settlement, ...leafInput } = reviewInput;
  const terminalSchema = PluginJsonSchemaV2Schema.parse(zodSchemaToJsonSchemaObject(ReviewStartNativeTerminalValueV1Schema, { target: 'draft-7' }));
  stages.forEach((stage, stepIndex) => {
    const stageId = `step-${stepIndex + 1}`;
    const prepared = result('prepare', [], { kind: 'outer', levels: 1 });
    const round = result('prepare', ['reviewRound'], { kind: 'outer', levels: 1 });
    const previous = stepIndex > 0 ? [result(`step-${stepIndex}-result`, [], { kind: 'outer', levels: 1 })] : [];
    const instructions = stage.kind === 'verify'
      ? `${REVIEW_FINDINGS_VERIFY_ONLY_INSTRUCTIONS_V1}\nRead this Review's canonical finding pages with reviews.comments.list and follow the cursor when more findings are needed.\n${stage.instructions}`
      : `${stage.instructions}\nReview read-only. Return structured findings, including a complete empty result when no defects are found.`;
    const branches = stage.reviewers.flatMap<Extract<WorkflowBlock, { kind: 'parallel' }>['branches'][number]>((reviewer, reviewerIndex) => {
        if (reviewer.kind === 'person') return [];
        const { includeSessionTranscript, ...participant } = reviewer;
        const reviewerInstructions = includeSessionTranscript && transcriptInput
          ? `${instructions}\n\n${transcriptInput}` : instructions;
        const reviewerId = reviewReviewerIdForSelectionV1(reviewerIndex, stepIndex);
        if (reviewer.kind === 'engine') {
          const references = [prepared, ...previous].map((_, index) => {
            const ref = buildMentionRefForKindV1(MENTION_KIND_V1.workflowInput, String(index));
            const label = index === 0 ? 'Prepared Review' : 'Previous step';
            return { kind: MENTION_KIND_V1.workflowInput, ref, label, token: formatInlineReferenceTokenV1({ ref, label }) };
          });
          const bindings: Record<string, WorkflowActionFieldBindingV1> = Object.fromEntries(Object.entries(leafInput)
            .filter(([, value]) => value !== undefined).map(([key, value]) => [key, literal(StrictJsonValueSchema.parse(value))]));
          return [{ id: `branch-${reviewerId}`, blocks: [{ kind: 'action' as const, id: reviewerId, name: 'Run the selected reviewer', actionId: 'review.start',
            ...(reviewer.roleId ? { execution: { roleId: reviewer.roleId } } : {}),
            input: { ...bindings, reviewers: literal([StrictJsonValueSchema.parse(participant)]),
              instructions: { kind: 'text' as const,
                document: { text: `${reviewerInstructions}\n\n${references.map(reference => reference.token).join('\n\n')}`, references },
                input: [prepared, ...previous] },
              permissionMode: literal('read_only'),
              reviewRound: round, reviewReviewerId: literal(reviewerId), reviewRoundSettlement: literal('workflow'),
              newRoundCostConsent: result('prepare', ['newRoundCostConsent'], { kind: 'outer', levels: 1 }),
              ...(comparison || reviewInput.comparisonId
                ? { comparisonId: result('prepare', ['comparisonId'], { kind: 'outer', levels: 1 }) } : {}),
            } }] }];
        }
        const participantName = `reviewer_${stepIndex + 1}_${reviewerIndex + 1}`;
        inputs[participantName] = StrictJsonValueSchema.parse(reviewer.kind === 'model'
          ? { ...participant, launch: { ...reviewer.launch, permissionMode: 'read-only' } } : participant);
        declarations.push({ name: participantName, valueType: 'json', required: true, inputType: { hostType: 'agentParticipant' } });
        return [{ id: `branch-${reviewerId}`, blocks: [{ kind: 'step' as const, id: reviewerId, name: 'Review with the selected participant',
          document: document(reviewerInstructions), execution: { participant: { kind: 'input' as const, name: participantName }, permissionMode: 'read-only' as const },
          input: [prepared, literal({ kind: 'review_session.v1', reviewerId }), ...previous], result: { kind: 'json' as const, schema: terminalSchema },
        }] }];
      });
    if (branches.length > 0) {
      stageIds.push(stageId);
      blocks.push({ kind: 'parallel', id: stageId, name: stage.kind === 'verify' ? 'Double-check the findings' : 'Review the code',
        failurePolicy: 'collect_outcomes', branches });
    }
    if (stepIndex < stages.length - 1) blocks.push({ kind: 'action', id: `${stageId}-result`, name: 'Read the persisted Review result',
      actionId: 'review.get', input: { reviewId: result('prepare', ['reviewRound', 'reviewId']) } });
  });
  blocks.push({ kind: 'action', id: 'settle', name: 'Settle the Review coverage', actionId: 'review.settle_round', input: {
    reviewRound: result('prepare', ['reviewRound']), reviewerResults: { kind: 'list', items: stageIds.map(id => result(id)) },
  } });
  if (reviewInput.then === 'fix') blocks.push({ kind: 'action', id: 'fix', name: 'Fix accepted findings once', actionId: 'review.apply', input: {
    reviewId: result('prepare', ['reviewRound', 'reviewId']),
    sessionId: reviewInput.sessionId ? literal(reviewInput.sessionId) : { kind: 'origin_session_id' },
  } });
  blocks.push({ kind: 'action', id: 'review-result', name: 'Read the persisted Review result', actionId: 'review.get',
    input: { reviewId: result('prepare', ['reviewRound', 'reviewId']) } });
  return { definition: { version: 1, defaults: {}, inputs: declarations, blocks, finalOutput: result('review-result') }, inputs };
}

const starterReferences = ['Reviewers', 'Review instructions'].map((label, index) => {
  const ref = buildMentionRefForKindV1(MENTION_KIND_V1.workflowInput, String(index));
  return { kind: MENTION_KIND_V1.workflowInput, ref, label, token: formatInlineReferenceTokenV1({ ref, label }) };
});

function startReview(withSteps: boolean): WorkflowActionLeafV1 {
  return { kind: 'action', id: withSteps ? 'review-steps' : 'review', name: 'Review the changes', actionId: 'review.start', input: {
    sessionId: { kind: 'input', name: 'reviewSession', path: ['sessionId'] },
    reviewers: input('reviewers'), instructions: input('focus'), then: input('then'),
    steps: withSteps ? input('steps') : { kind: 'text', document: {
      text: `[{"kind":"review","reviewers":${starterReferences[0]!.token},"instructions":${starterReferences[1]!.token}}]`,
      references: starterReferences,
    }, input: [input('reviewers'), input('focus')] },
  } };
}

/** New starts run the selected steps once; saved historical graphs retain their own loop. */
export const REVIEW_AND_CONVERGE_WORKFLOW_V1: WorkflowDefinitionV1 = {
  version: 1, defaults: {},
  inputs: [
    { name: 'reviewSession', valueType: 'json', required: true, inputType: { hostType: 'session' }, defaultFrom: 'origin_session' },
    { name: 'reviewers', valueType: 'json', required: true },
    { name: 'steps', valueType: 'json', required: false },
    { name: 'then', valueType: 'string', required: false, default: 'report', enum: ['report', 'fix'] },
    { name: 'focus', valueType: 'string', required: false, default: 'Review the changes made in this session.' },
  ],
  blocks: [{ kind: 'if', id: 'review-composition', name: 'Run the selected Review steps',
    when: { kind: 'exists', value: input('steps') }, then: [startReview(true)], otherwise: [startReview(false)] }],
  finalOutput: result('review-composition'),
};
